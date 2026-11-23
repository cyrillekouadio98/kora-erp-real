'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { Alert, Field, Pill, useAction } from '@/components/ui';

const SECURITY: Record<string, { label: string; port: number; secure: boolean }> = {
  ssl: { label: 'SSL/TLS (port 465, recommandé)', port: 465, secure: true },
  starttls: { label: 'STARTTLS (port 587)', port: 587, secure: false },
};
const EMPTY = { host: 'mail.systalink.com', security: 'ssl', port: '465', username: 'no-reply@koraerp.ci', password: '', fromAddress: 'no-reply@koraerp.ci' };

/** Serveur d'envoi des e-mails de la plateforme (invitations, mots de passe oubliés, documents, rappels). */
export default function ConsoleEmails() {
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [testTo, setTestTo] = useState('');
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const d = await api<any>('/platform/mail-settings');
    setData(d);
    if (d.settings) setForm({ host: d.settings.host, security: d.settings.secure ? 'ssl' : 'starttls', port: String(d.settings.port), username: d.settings.username, password: '', fromAddress: d.settings.fromAddress });
  }, []);
  useEffect(() => { run(load); }, [load]); // eslint-disable-line
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault(); setNotice('');
    run(async () => {
      await api('/platform/mail-settings', { method: 'PUT', body: { host: form.host, port: Number(form.port), secure: SECURITY[form.security].secure, username: form.username, fromAddress: form.fromAddress, ...(form.password ? { password: form.password } : {}) } });
      setNotice('Connexion au serveur réussie : réglages enregistrés. Envoyez maintenant un e-mail de test.');
      await load();
    });
  };
  const test = (e: React.FormEvent) => {
    e.preventDefault(); setNotice('');
    run(async () => { const r = await api<any>('/platform/mail-settings/test', { body: { to: testTo } }); setNotice(`E-mail de test envoyé à ${testTo} depuis ${r.from}. Vérifiez la boîte de réception (et les indésirables).`); });
  };
  const remove = () => {
    if (!window.confirm('Supprimer ces réglages ? Les e-mails ne partiront plus (sauf si la variable SMTP_URL est définie sur le serveur).')) return;
    setNotice(''); run(async () => { await api('/platform/mail-settings', { method: 'DELETE' }); setForm(EMPTY); await load(); });
  };
  if (!data) return <><div className="page-head"><h1>Envoi des e-mails</h1></div><Alert>{error}</Alert></>;
  const week = data.lastWeek ?? {};
  return (
    <>
      <div className="page-head"><h1>Envoi des e-mails</h1>
        {data.source === 'console' ? <Pill tone="ok">Actif — réglé ici</Pill> : data.source === 'environment' ? <Pill tone="ok">Actif — variable SMTP_URL du serveur</Pill> : <Pill tone="crit">Inactif : aucun e-mail ne part</Pill>}</div>
      <p className="muted" style={{ margin: 0 }}>Serveur utilisé pour tous les e-mails de Kora : invitations, mots de passe oubliés, documents envoyés aux clients, rappels de rendez-vous.</p>
      {data.source === 'none' && <Alert kind="warn">Tant qu'aucun serveur n'est réglé, les e-mails restent dans Kora sans être envoyés.</Alert>}
      <Alert>{error}</Alert>
      {notice && <Alert kind="ok">{notice}</Alert>}

      <form className="card" style={{ display: 'grid', gap: 12 }} onSubmit={save}>
        <header><h2>Serveur d'envoi (SMTP)</h2>{data.settings && <span className="small muted">modifié le {date(data.settings.updatedAt)}</span>}</header>
        <div className="grid2">
          <Field label="Serveur" required placeholder="mail.systalink.com" value={form.host} onChange={set('host')} />
          <label className="field">Sécurité<select className="input" value={form.security} onChange={(e) => setForm({ ...form, security: e.target.value, port: String(SECURITY[e.target.value].port) })}>
            {Object.entries(SECURITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
          <Field label="Port" type="number" required min={1} max={65535} value={form.port} onChange={set('port')} />
          <Field label="Identifiant (adresse de la boîte)" required autoComplete="off" value={form.username} onChange={set('username')} />
          <Field label={data.settings ? 'Mot de passe (laisser vide pour garder l’actuel)' : 'Mot de passe de la boîte'} type="password" autoComplete="new-password" required={!data.settings} value={form.password} onChange={set('password')} />
          <Field label="Adresse d'expédition" type="email" required value={form.fromAddress} onChange={set('fromAddress')} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>Kora se connecte au serveur avec ces identifiants avant d'enregistrer : un mauvais mot de passe est refusé tout de suite. Le mot de passe est chiffré et n'est plus jamais affiché. L'adresse d'expédition doit appartenir au domaine autorisé par le serveur (ex. no-reply@koraerp.ci chez Systalink).</p>
        <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Connexion au serveur…' : 'Tester la connexion et enregistrer'}</button>
          {data.source === 'console' && <button type="button" className="btn danger" disabled={busy} onClick={remove}>Supprimer les réglages</button>}</div>
      </form>

      {data.source !== 'none' && <form className="card" style={{ display: 'grid', gap: 12 }} onSubmit={test}>
        <header><h2>E-mail de test</h2></header>
        <div className="row" style={{ alignItems: 'end' }}>
          <div style={{ flex: 1, minWidth: 220 }}><Field label="Envoyer à" type="email" required placeholder="vous@exemple.ci" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></div>
          <button className="btn" disabled={busy}>Envoyer le test</button></div>
      </form>}

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <header><h2>7 derniers jours</h2></header>
        <div className="row small">
          <span>Envoyés : <b>{week.sent ?? 0}</b></span><span>En attente : <b>{week.queued ?? 0}</b></span><span>En échec : <b style={{ color: week.failed ? 'var(--crit)' : undefined }}>{week.failed ?? 0}</b></span></div>
        {data.lastError && <p className="small muted" style={{ margin: 0 }}>Dernière erreur ({date(data.lastError.at)}) : {data.lastError.message}</p>}
      </div>
    </>
  );
}
