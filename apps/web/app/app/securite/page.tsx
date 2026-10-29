'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSession } from '@/components/session';
import { Alert, Field, Pill, useAction } from '@/components/ui';

export default function SecurityPage() {
  const { me, refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [sessions, setSessions] = useState<any[]>([]);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [ok, setOk] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setSessions(await api('/auth/sessions')), []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="page-head"><h1>Ma sécurité</h1></div>
      <Alert>{error}</Alert><Alert kind="ok">{ok}</Alert>
      <div className="card form">
        <header><h2>Double authentification</h2>{me.user.mfaEnabled ? <Pill tone="ok">Activée</Pill> : <Pill tone="warn">Non activée</Pill>}</header>
        {!me.user.mfaEnabled && !setup && <div><p className="muted small">Protégez votre compte avec une application d'authentification (Google Authenticator, Microsoft Authenticator…).</p><button className="btn primary" disabled={busy} onClick={() => run(async () => setSetup(await api('/auth/mfa/setup', { method: 'POST', body: {} })))}>Configurer</button></div>}
        {setup && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/auth/mfa/enable', { body: { code } }); setSetup(null); setOk('Double authentification activée.'); await refresh(); }); }}>
            <p className="small">Ajoutez un compte dans votre application avec cette clé, puis saisissez le code affiché :</p>
            <code className="k" style={{ fontSize: 16, letterSpacing: '.08em', wordBreak: 'break-all' }}>{setup.secret}</code>
            <div className="row"><div style={{ width: 200 }}><Field label="Code à 6 chiffres" inputMode="numeric" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} /></div><button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={busy}>Activer</button></div>
          </form>
        )}
      </div>
      <form className="card form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/auth/password', { body: pw }); setPw({ currentPassword: '', newPassword: '' }); setOk('Mot de passe modifié. Vos autres sessions ont été fermées.'); await load(); }); }}>
        <header><h2>Mot de passe</h2></header>
        <div className="grid2"><Field label="Mot de passe actuel" type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /><Field label="Nouveau mot de passe (10 caractères min.)" type="password" minLength={10} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
        <div><button className="btn" disabled={busy}>Changer le mot de passe</button></div>
      </form>
      <div className="card"><header><h2>Sessions ouvertes</h2></header>
        <div className="table-wrap"><table><tbody>{sessions.map((s) => (
          <tr key={s.id}><td className="small">{s.userAgent ?? 'Appareil inconnu'}<div className="muted">{s.ip}</div></td><td className="small">active {dateTime(s.lastSeenAt)}</td>
            <td className="n">{s.current ? <Pill tone="ok">Cette session</Pill> : <button className="btn sm danger" onClick={() => run(async () => { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); await load(); })}>Fermer</button>}</td></tr>))}</tbody></table></div>
      </div>
    </>
  );
}
