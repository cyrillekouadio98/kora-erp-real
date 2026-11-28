import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, platformUser, resetDb, signup, uniqueEmail } from './helpers';

/** Restaurant : plan de salle, commande ouverte par table, transfert, encaissement en ticket, annulation. */
describe('Restaurant : plan de salle et commandes à table', () => {
  let app: INestApplication;
  let owner: Awaited<ReturnType<typeof signup>>;
  let waiter: ReturnType<typeof request.agent>;
  let register: string, session: string, area: string, t1: string, t2: string, beer: string, garba: string, order: string;
  const floor = async () => (await owner.agent.get(`/company/restaurant/floor?registerId=${register}`)).body;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    owner = await signup(app);
    await owner.agent.post('/company/subscription/change').send({ planCode: 'premium', billingCycle: 'monthly' });
    beer = (await owner.agent.post('/company/products').send({ name: 'Bière 65 cl', salePrice: 1000, purchasePrice: 600, vatRate: 18, unit: 'bouteille' })).body.id;
    garba = (await owner.agent.post('/company/products').send({ kind: 'service', name: 'Garba', salePrice: 1500, vatRate: 0 })).body.id;
    await owner.agent.post(`/company/stock/${beer}/opening`).send({ quantity: 48, unitCost: 600 });
    register = (await owner.agent.post('/company/pos/registers').send({ name: 'Caisse bar' })).body.id;
    // Un serveur : rôle Caissier (prend les commandes et encaisse), sans droit d'annuler une commande servie.
    const role = (await owner.agent.get('/company/roles')).body.find((r: any) => r.key === 'cashier');
    const inv = await owner.agent.post('/company/invitations').send({ email: uniqueEmail('serveur'), roleIds: [role.id] });
    waiter = request.agent(app.getHttpServer());
    await waiter.post('/invitations/accept').send({ token: new URL(inv.body.inviteUrl).searchParams.get('token'), fullName: 'Serveur Koffi', password: 'MotDePasse123' });
  });
  afterAll(async () => { await app.close(); });

  it("reste fermé tant que la fonctionnalité n'est pas activée", async () => {
    expect((await owner.agent.get('/company/restaurant/floor')).body.error.code).toBe('feature_not_enabled');
    const sales = await platformUser(app, 'sales_admin');
    await sales.agent.put(`/platform/companies/${owner.companyId}/features/restaurant_tables`).send({ enabled: true });
  });

  it('dessine le plan : salles et tables placées sur la grille', async () => {
    area = (await owner.agent.post('/company/restaurant/areas').send({ name: 'Salle', registerId: register })).body.id;
    expect((await owner.agent.post('/company/restaurant/areas').send({ name: 'salle' })).body.error.code).toBe('area_exists');
    t1 = (await owner.agent.post('/company/restaurant/tables').send({ areaId: area, name: 'T1', seats: 4, x: 0, y: 0 })).body.id;
    t2 = (await owner.agent.post('/company/restaurant/tables').send({ areaId: area, name: 'T2', seats: 2, shape: 'round', x: 2, y: 0 })).body.id;
    expect((await owner.agent.post('/company/restaurant/tables').send({ areaId: area, name: 't1' })).body.error.code).toBe('table_exists');
    expect((await waiter.post('/company/restaurant/tables').send({ areaId: area, name: 'T9' })).status).toBe(403); // le plan est réservé à l'administrateur des caisses
    expect((await owner.agent.patch(`/company/restaurant/tables/${t2}`).send({ x: 3, y: 1 })).body).toEqual({ ok: true });
    const f = await floor();
    expect(f.areas).toHaveLength(1);
    expect(f.areas[0].tables.map((x: any) => [x.name, x.x, x.y, x.order])).toEqual([['T1', 0, 0, null], ['T2', 3, 1, null]]);
  });

  it('ouvre une table, ajoute des articles au fil du repas et la transfère', async () => {
    const o = (await waiter.post(`/company/restaurant/tables/${t1}/orders`).send({ guests: 3 })).body;
    order = o.id;
    expect(o).toMatchObject({ tableName: 'T1', guests: 3, lines: [], totals: { ttc: 0 } });
    expect((await waiter.post(`/company/restaurant/tables/${t1}/orders`).send({})).body.error.code).toBe('table_busy');
    let r = (await waiter.post(`/company/restaurant/orders/${order}/lines`).send({ lines: [{ productId: beer, quantity: 3 }, { productId: garba, quantity: 2, note: 'sans piment' }] })).body;
    expect(r.totals).toEqual({ ht: 6000, vat: 540, ttc: 6540 });
    r = (await waiter.post(`/company/restaurant/orders/${order}/lines`).send({ lines: [{ productId: beer, quantity: 1 }] })).body;
    expect(r.lines.map((l: any) => [l.description, l.quantity])).toEqual([['Bière 65 cl', 4], ['Garba', 2]]); // même article sans remarque : ligne regroupée
    r = (await waiter.post(`/company/restaurant/orders/${order}/lines`).send({ lines: [{ productId: beer, quantity: 1, note: 'bien fraîche' }] })).body;
    expect(r.lines).toHaveLength(3);
    const last = r.lines[2].id;
    r = (await waiter.patch(`/company/restaurant/orders/${order}/lines/${last}`).send({ quantity: 2 })).body;
    expect(r.totals.ttc).toBe(10080);
    r = (await waiter.delete(`/company/restaurant/orders/${order}/lines/${last}`)).body;
    expect(r.totals.ttc).toBe(7720);
    const beerLine = r.lines.find((l: any) => l.description === 'Bière 65 cl').id;
    r = (await waiter.patch(`/company/restaurant/orders/${order}/lines/${beerLine}`).send({ quantity: 3 })).body;
    expect(r.totals.ttc).toBe(6540);
    const f = await floor();
    expect(f.areas[0].tables[0].order).toMatchObject({ id: order, guests: 3, items: 2, total: 6540 });
    expect((await owner.agent.patch(`/company/restaurant/tables/${t1}`).send({ archived: true })).body.error.code).toBe('table_busy');
    expect((await waiter.post(`/company/restaurant/orders/${order}/move`).send({ tableId: t2 })).body.tableName).toBe('T2');
    expect((await floor()).areas[0].tables.map((x: any) => !!x.order)).toEqual([false, true]);
  });

  it("encaisse la commande en ticket de caisse : stock et trésorerie suivent", async () => {
    expect((await waiter.post(`/company/restaurant/orders/${order}/pay`).send({ sessionId: '00000000-0000-4000-8000-000000000000', payments: [{ method: 'cash', amount: 7000 }] })).status).toBe(404);
    session = (await waiter.post(`/company/pos/registers/${register}/open`).send({ openingFloat: 5000 })).body.id;
    expect((await waiter.post(`/company/restaurant/orders/${order}/pay`).send({ sessionId: session, payments: [{ method: 'cash', amount: 5000 }] })).body.error.code).toBe('underpaid');
    const ticket = (await waiter.post(`/company/restaurant/orders/${order}/pay`).send({ sessionId: session, payments: [{ method: 'cash', amount: 7000 }] })).body;
    expect(ticket).toMatchObject({ totalTtc: 6540, change: 460 });
    expect(ticket.number).toMatch(/^TK-/);
    expect((await owner.agent.get(`/company/restaurant/orders/${order}`)).body).toMatchObject({ status: 'paid', ticketId: ticket.id });
    expect((await waiter.post(`/company/restaurant/orders/${order}/lines`).send({ lines: [{ productId: beer, quantity: 1 }] })).body.error.code).toBe('order_closed');
    expect((await owner.agent.get(`/company/stock/${beer}/movements`)).body.product.stock_qty).toBe(45);
    expect((await floor()).areas[0].tables.every((x: any) => !x.order)).toBe(true);
  });

  it("annule : libre si la commande est vide, sinon avec un motif et l'accord du responsable", async () => {
    const empty = (await waiter.post(`/company/restaurant/tables/${t1}/orders`).send({})).body.id;
    expect((await waiter.post(`/company/restaurant/orders/${empty}/cancel`).send({})).body).toEqual({ ok: true });
    const served = (await waiter.post(`/company/restaurant/tables/${t1}/orders`).send({ guests: 2 })).body.id;
    await waiter.post(`/company/restaurant/orders/${served}/lines`).send({ lines: [{ productId: beer, quantity: 2 }] });
    await waiter.post(`/company/restaurant/orders/${served}/send`);
    expect((await waiter.post(`/company/restaurant/orders/${served}/cancel`).send({ reason: 'Client parti' })).body.error.code).toBe('cancel_needs_manager');
    expect((await owner.agent.post(`/company/restaurant/orders/${served}/cancel`).send({})).body.error.code).toBe('reason_required');
    expect((await owner.agent.post(`/company/restaurant/orders/${served}/cancel`).send({ reason: 'Client parti sans consommer' })).body).toEqual({ ok: true });
    expect((await owner.agent.get(`/company/stock/${beer}/movements`)).body.product.stock_qty).toBe(45); // rien n'est sorti du stock
  });

  it('envoie en cuisine et au bar : un bon par poste, prêt puis servi', async () => {
    const coke = (await owner.agent.post('/company/products').send({ name: 'Coca 33 cl', salePrice: 500, vatRate: 18 })).body.id;
    expect((await waiter.put('/company/restaurant/stations').send({ productIds: [beer], station: 'bar' })).status).toBe(403);
    expect((await owner.agent.put('/company/restaurant/stations').send({ productIds: [beer], station: 'bar' })).body).toEqual({ updated: 1 });
    await owner.agent.put('/company/restaurant/stations').send({ productIds: [coke], station: 'none' });
    expect((await owner.agent.get('/company/restaurant/stations')).body.find((p: any) => p.id === garba).station).toBe('kitchen');

    const o = (await waiter.post(`/company/restaurant/tables/${t2}/orders`).send({ guests: 2 })).body.id;
    expect((await waiter.post(`/company/restaurant/orders/${o}/send`)).body.error.code).toBe('nothing_to_send');
    await waiter.post(`/company/restaurant/orders/${o}/lines`).send({ lines: [{ productId: garba, quantity: 2, note: 'sans piment' }, { productId: beer, quantity: 2 }, { productId: coke, quantity: 1 }] });
    const r = (await waiter.post(`/company/restaurant/orders/${o}/send`)).body;
    expect(r.tickets.map((k: any) => [k.station, k.tableName, k.lines.map((l: any) => `${l.quantity} ${l.description}${l.note ? ` (${l.note})` : ''}`)])).toEqual([
      ['kitchen', 'T2', ['2 Garba (sans piment)']], ['bar', 'T2', ['2 Bière 65 cl']]]);
    expect(r.tickets[1].number).toBe(r.tickets[0].number + 1);
    expect(r.order.unsent).toBe(0);
    expect(r.order.lines.find((l: any) => l.description === 'Coca 33 cl').sentAt).not.toBeNull(); // sans préparation : pas de bon

    // Ajouter après l'envoi : nouvelle ligne, pas de regroupement avec l'article déjà parti.
    let ord = (await waiter.post(`/company/restaurant/orders/${o}/lines`).send({ lines: [{ productId: garba, quantity: 1 }] })).body;
    expect(ord.lines.filter((l: any) => l.description === 'Garba')).toHaveLength(2);
    const sent = ord.lines.find((l: any) => l.description === 'Garba' && l.sentAt);
    expect((await waiter.patch(`/company/restaurant/orders/${o}/lines/${sent.id}`).send({ quantity: 3 })).body.error.code).toBe('line_sent');
    expect((await waiter.delete(`/company/restaurant/orders/${o}/lines/${sent.id}`)).body.error.code).toBe('line_sent_needs_manager');
    ord = (await owner.agent.patch(`/company/restaurant/orders/${o}/lines/${sent.id}`).send({ quantity: 1 })).body;
    expect(ord.lines.find((l: any) => l.id === sent.id).quantity).toBe(1);

    // Écran de la cuisine : le bon à préparer, puis prêt ; la table l'affiche ; le serveur le marque servi.
    let board = (await owner.agent.get(`/company/restaurant/kitchen?station=kitchen&registerId=${register}`)).body;
    expect(board.pending.map((k: any) => k.tableName)).toEqual(['T2']);
    expect(board.counts).toEqual({ kitchen: 1, bar: 1 });
    const kid = board.pending[0].id;
    expect((await waiter.post(`/company/restaurant/kitchen/${kid}/ready`)).body).toEqual({ ok: true });
    board = (await owner.agent.get(`/company/restaurant/kitchen?station=kitchen&registerId=${register}`)).body;
    expect([board.pending.length, board.ready.length]).toEqual([0, 1]);
    expect((await floor()).areas[0].tables.find((x: any) => x.name === 'T2').order).toMatchObject({ ready: 1, pending: 1 });
    await waiter.post(`/company/restaurant/kitchen/${kid}/served`);
    expect((await owner.agent.get(`/company/restaurant/kitchen?station=kitchen&registerId=${register}`)).body.ready).toHaveLength(0);
    expect((await waiter.post(`/company/restaurant/kitchen/${kid}/eaten`)).status).toBe(404);

    // Annuler la commande annule aussi ses bons en attente.
    await owner.agent.post(`/company/restaurant/orders/${o}/cancel`).send({ reason: 'Erreur de table' });
    expect((await owner.agent.get(`/company/restaurant/kitchen?station=bar&registerId=${register}`)).body.pending).toHaveLength(0);
  });
});
