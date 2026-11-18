import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Storefront } from './Storefront.jsx';
import { usesAdminPortal, usesTurkeyStorefront,usesMerchandiseStorefront } from '../storefrontRouting.js';
const TurkeyStorefront = lazy(() => import('./TurkeyStorefront.jsx').then(module => ({ default: module.TurkeyStorefront })));
const AdminPortal = lazy(() => import('./AdminPortal.jsx').then(module => ({ default: module.AdminPortal })));
const MerchandiseStorefront=lazy(()=>import('./MerchandiseStorefront.jsx').then(module=>({default:module.MerchandiseStorefront})));

export function StoreRouter() {
  const [location, setLocation] = useState(window.location.href);
  useEffect(() => {
    const update = () => setLocation(window.location.href);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  if (usesAdminPortal(location)) return <Suspense fallback={<p className="container">Loading admin…</p>}><AdminPortal /></Suspense>;
  if(usesMerchandiseStorefront(location))return <Suspense fallback={<p className="container">Loading merchandise…</p>}><MerchandiseStorefront/></Suspense>;
  const turkey = usesTurkeyStorefront(location);
  return turkey ? <Suspense fallback={<p className="container">Loading turkey preorders…</p>}><TurkeyStorefront /></Suspense> : <Storefront />;
}
