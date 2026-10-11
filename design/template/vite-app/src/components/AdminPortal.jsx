import React, { useEffect, useState } from 'react';
import { AdminPanel } from './AdminPanel.jsx';

export function AdminPortal() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.title = 'Full Farm CSA Admin';
    // Preserve the existing Timesheets launch flow. Consume its token before
    // mounting the panel so it reads the session once and logout cannot replay it.
    const url = new URL(window.location.href);
    const [route, query = ''] = url.hash.replace(/^#\/?/, '').split('?');
    const params = new URLSearchParams(query);
    const launchToken = route === 'admin' ? params.get('adminToken') : null;
    if (launchToken) {
      localStorage.setItem('adminToken', launchToken);
      params.delete('adminToken');
      const remainingQuery = params.toString();
      url.hash = `#/admin${remainingQuery ? `?${remainingQuery}` : ''}`;
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    setReady(true);
  }, []);

  return (
    <div className="page">
      <main>
        <div className="utility-bar">
          <div className="brand">
            <img src="/images/full-farm-csa-logo.png" alt="Full Farm CSA" />
            <span className="brand-title">Full Farm CSA Admin</span>
          </div>
        </div>
        {ready ? <AdminPanel /> : <p className="container">Opening admin…</p>}
      </main>
    </div>
  );
}
