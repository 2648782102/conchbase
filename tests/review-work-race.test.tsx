// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAttentionWorkbench } from '../src/features/work/useAttentionWorkbench.js';
const digest='sha256:'+'b'.repeat(64);
const runtime:any={name:'Conchbase',version:'1.0.0',state:'ready',capabilities:['durable-work-contract']};
const item=(id:string,state='open')=>({version:2,id,state,threadId:'t'+id,triggerId:'trg_'+id,mandateId:'man_'+id,mandateRevision:1});
const d1=item('work_a'); const d2=item('work_b');
const detail=(w:any)=>({version:2,workItem:w,thread:{version:2,id:w.threadId,threadKey:'thread-'+w.id,contextOnly:true,triggerIds:[w.triggerId],workItemId:w.id},mandate:{version:2,id:w.mandateId,workItemId:w.id,revision:1,scope:['x'],allowedOperations:['observe'],capabilitiesDigest:digest},assignments:[],outbox:[],deliveryReceipts:[]});
function json(b:unknown,s=200){return new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}})}
const flush=()=>new Promise(r=>setTimeout(r,0));
describe('work selection race',()=>{afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('keeps user selection when an earlier load detail request finishes last',async()=>{
 const detailResolvers:Record<string,((v:Response)=>void)[]>={};
 let listCalls=0;
 vi.stubGlobal('fetch', vi.fn((input:RequestInfo|URL)=>{
  const p=String(input);
  if(p==='/v1/work/items'){listCalls++;return Promise.resolve(json({version:2,workItems:[d1,d2]}));}
  if(p==='/v1/work/delivery-receipts') return Promise.resolve(json({version:2,deliveryReceipts:[]}));
  if(p==='/v1/work/events') return Promise.resolve(json({version:2,events:[]}));
  if(p.startsWith('/v1/work/items/')){const id=decodeURIComponent(p.slice('/v1/work/items/'.length));return new Promise<Response>(r=>{(detailResolvers[id]??=[]).push(r)});}
  return Promise.resolve(json({},500));
 }));
 function H(){const s=useAttentionWorkbench(runtime);return <><p data-testid="sel">{s.selectedWorkItemId}</p><p data-testid="detail">{s.detail?.workItem.id??''}</p><button onClick={()=>s.select('work_b')}>select b</button><button onClick={()=>s.load()}>refresh</button></>}
 render(<H/>);
 // initial load requests work_a detail
 await waitFor(()=>expect(detailResolvers.work_a?.length).toBe(1));
 act(()=>{detailResolvers.work_a![0]!(json(detail(d1)));});
 await waitFor(()=>expect(screen.getByTestId('sel').textContent).toBe('work_a'));
 // user selects b while a refresh's load is in flight. Let the select request complete first.
 act(()=>{screen.getByRole('button',{name:'select b'}).click();});
 await waitFor(()=>expect(detailResolvers.work_b?.length).toBe(1));
 act(()=>{detailResolvers.work_b![0]!(json(detail(d2)));});
 await waitFor(()=>expect(screen.getByTestId('sel').textContent).toBe('work_b'));
 // trigger refresh; list runs, then sees selected b and requests b detail (stale b load). We want a second selection to a while refresh pending.
