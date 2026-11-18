import express from 'express';
import { requireAdminPermission } from '../middleware/auth.js';
import { getMerchandiseService,merchandiseStripeEvent,merchandisePrintifyEvent } from '../lib/merchandiseRuntime.js';
export function createMerchandiseRouters({getService=getMerchandiseService,adminAuth=requireAdminPermission('merchandise_admin')}={}) {
  const publicRouter=express.Router(), adminRouter=express.Router();
  const wrap=fn=>async(req,res)=>{try{await fn(req,res,getService());}catch(e){if(!e.status)console.error('Merchandise request failed',{route:req.route?.path,code:e.code || 'internal'});res.status(e.status || 500).json({error:e.status?e.message:'Unable to complete merchandise request. Retry the same order if checkout was interrupted.',...(e.checkoutRejected===true?{checkoutRejected:true}:{})});}};
  const access=req=>String(req.headers.authorization || '').replace(/^Bearer /,'');
  const actor=req=>req.admin?.userId || req.admin?.adminId;
  const attempts=new Map();
  publicRouter.use((req,res,next)=>{
    res.set('Cache-Control','no-store'); const time=Date.now();
    for(const [key,value] of attempts)if(value.until<time)attempts.delete(key);
    const row=attempts.get(req.ip) || {count:0,until:time+60000};
    if (++row.count>90 || attempts.size>10000) return res.status(429).json({error:'Please wait a minute before retrying.'});
    attempts.set(req.ip,row);next();
  });
  publicRouter.get('/catalog',wrap(async(_req,res,s)=>res.json(await s.catalog())));
  publicRouter.post('/quote',wrap(async(req,res,s)=>res.json(await s.quote(req.body))));
  publicRouter.post('/checkout',wrap(async(req,res,s)=>res.json(await s.checkout(req.body,req.get('origin')))));
  publicRouter.post('/orders/:id/resume',wrap(async(req,res,s)=>res.json(await s.resumeCheckout(req.params.id,access(req)))));
  publicRouter.get('/orders/:id',wrap(async(req,res,s)=>res.json(await s.viewOrder(req.params.id,access(req)))));
  adminRouter.use(adminAuth);
  adminRouter.get('/catalog',wrap(async(_req,res,s)=>res.json(await s.catalog(true))));
  adminRouter.put('/products/:id',wrap(async(req,res,s)=>res.json(await s.saveProduct(req.params.id,req.body,actor(req)))));
  adminRouter.post('/products/:id/refresh',wrap(async(req,res,s)=>res.json(await s.refreshProduct(req.params.id,actor(req)))));
  adminRouter.get('/orders',wrap(async(_req,res,s)=>res.json({orders:await s.orders(),report:await s.report()})));
  adminRouter.post('/fulfillments/:id/retry',wrap(async(req,res,s)=>res.json(await s.processFulfillment(req.params.id))));
  adminRouter.post('/orders/:id/fees',wrap(async(req,res,s)=>{await s.refreshFees(req.params.id);res.json(await s.viewOrder(req.params.id,null,true));}));
  adminRouter.post('/orders/:id/stripe-session',wrap(async(req,res,s)=>res.json(await s.recoverCheckout(req.params.id,req.body.sessionId))));
  adminRouter.post('/orders/:id/refunds/reconcile',wrap(async(req,res,s)=>res.json(await s.reconcileFinances(req.params.id,req.body.acknowledgeExternal===true,actor(req)))));
  adminRouter.post('/orders/:id/operations/review',wrap(async(req,res,s)=>res.json(await s.reviewOperation(req.params.id,req.body.kind,actor(req)))));
  adminRouter.post('/orders/:id/operations/:operationId/confirm',wrap(async(req,res,s)=>res.json(await s.confirmOperation(req.params.id,req.params.operationId,actor(req)))));
  return {publicRouter,adminRouter};
}
const routers=createMerchandiseRouters();
export const merchandiseRouter=routers.publicRouter, merchandiseAdminRouter=routers.adminRouter;
export async function merchandiseStripeWebhook(req,res) {
  let event;try{event=merchandiseStripeEvent(req.body,req.headers['stripe-signature']);}catch(e){return res.status(e.status || 400).json({error:e.message});}
  try{await getMerchandiseService().stripeWebhook(event);res.json({received:true});}
  catch{res.status(500).json({error:'Retry merchandise webhook processing.'});}
}
export async function merchandisePrintifyWebhook(req,res) {
  let event;try{event=merchandisePrintifyEvent(req.body,req.headers['x-pfy-signature']);}catch(e){return res.status(e.status || 400).json({error:e.message});}
  try{await getMerchandiseService().printifyWebhook(event);res.json({received:true});}
  catch{res.status(500).json({error:'Retry supplier webhook processing.'});}
}
