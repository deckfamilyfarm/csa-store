import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Storefront } from './Storefront.jsx';
import { usesTurkeyStorefront } from '../storefrontRouting.js';
const TurkeyStorefront = lazy(() => import('./TurkeyStorefront.jsx').then(module => ({ default: module.TurkeyStorefront })));

export function StoreRouter() {
  const [location, setLocation] = useState(window.location.href);
  useEffect(() => {
    const update = () => setLocation(window.location.href);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const turkey = usesTurkeyStorefront(location);
  return turkey ? <Suspense fallback={<p className="container">Loading turkey preorders…</p>}><TurkeyStorefront /></Suspense> : <Storefront />;
}
