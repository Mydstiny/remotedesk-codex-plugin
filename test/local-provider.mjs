import http from 'node:http';
import { randomUUID } from 'node:crypto';
export async function fixtureProvider(decide) {
 const calls=[];
 const server=http.createServer(async(req,res)=>{
  try {
   let bytes=0;const chunks=[];for await(const c of req){bytes+=c.length;if(bytes>4000000)throw new Error('FIXTURE_LIMIT');chunks.push(c);}
   const request=JSON.parse(Buffer.concat(chunks));calls.push({path:req.url,tools:request.tools?.map(t=>({name:t.name,type:t.type,namespace:t.namespace})),toolResults:request.input?.filter(i=>i.type==='function_call_output').map(i=>i.output)});
   const result=await decide(request,calls.length);
   if(result.hang){req.socket.on('close',()=>{});return;}
   const responseId='resp_'+randomUUID(), item=result.call?{id:'fc_'+randomUUID(),type:'function_call',status:'completed',call_id:'call_'+randomUUID(),name:result.call.name,arguments:JSON.stringify(result.call.arguments)}:{id:'msg_'+randomUUID(),type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:result.text??'fixture complete',annotations:[]}]};
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
   const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
   emit('response.created',{response:{id:responseId,object:'response',status:'in_progress',output:[]}});
   emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',...(result.call?{arguments:''}:{content:[]})}});
   if(result.call)emit('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});
   else {emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:item.content[0].text});}
   emit('response.output_item.done',{output_index:0,item});
   emit('response.completed',{response:{id:responseId,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  }catch{res.writeHead(500);res.end('fixture error');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {calls,overrides:{model_provider:'remotedesk_fixture',model:'remotedesk-fixture',model_reasoning_effort:'low',model_providers:{remotedesk_fixture:{name:'RemoteDesk local deterministic fixture',base_url:`http://127.0.0.1:${server.address().port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}},close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
