// Inject only endpoint-format hints and initialization failures in an owned app.
// Windows still captures, converts and encodes real audio. No device settings change.
const hooked=new Set(),processClients=new Set(),callbacks=[];
const method=(p,n)=>p.readPointer().add(n*Process.pointerSize).readPointer();
const guid=p=>Array.from(new Uint8Array(p.readByteArray(16)),b=>b.toString(16).padStart(2,'0')).join('');
const audioIid='4cadb91cfadb324cb178c2f568a703b2';
function attach(p,handlers){const k='attach:'+p;if(hooked.has(k))return;hooked.add(k);Interceptor.attach(p,handlers);}
function processClient(client){
 processClients.add(client.toString());const address=method(client,3),key='replace:'+address;
 if(hooked.has(key))return;hooked.add(key);
 const signature=['pointer','int','uint32','int64','int64','pointer','pointer'];
 const original=new NativeFunction(address,'int',signature);
 const callback=new NativeCallback((self,share,flags,buffer,period,format,session)=>{
  if(!processClients.has(self.toString()))return original(self,share,flags,buffer,period,format,session);
  const rate=format.add(4).readU32();let injected=0;
  if(FAULT==='reject-rate'&&rate!==48000)injected=0x88890008|0;
  if(FAULT==='invalid-rate'&&rate!==48000)injected=0x80070057|0;
  if(FAULT==='reject-all')injected=0x88890008|0;
  if(FAULT==='invalidated')injected=0x88890004|0;
  const result=injected||original(self,share,flags,buffer,period,format,session);
  send({kind:'process-initialize',rate,result,injected:!!injected});return result;
 },'int',signature);callbacks.push(callback);Interceptor.replace(address,callback);
}
function unknownClient(client){attach(method(client,0),{
 onEnter(args){this.output=guid(args[1])===audioIid?args[2]:null;},
 onLeave(result){if(this.output&&result.toInt32()>=0)processClient(this.output.readPointer());}
});}
function renderClient(client){attach(method(client,8),{
 onEnter(args){this.output=args[1];},
 onLeave(result){
  if(result.toInt32()<0||this.output.readPointer().isNull())return;
  const format=this.output.readPointer(),actualRate=format.add(4).readU32();
  if(RATE!==null){format.add(4).writeU32(RATE);format.add(8).writeU32(RATE*format.add(12).readU16());}
  send({kind:'render-hint',actualRate,requestedRate:RATE??actualRate});
 }
});}
function endpoint(device){attach(method(device,3),{
 onEnter(args){this.output=guid(args[1])===audioIid?args[4]:null;},
 onLeave(result){if(this.output&&result.toInt32()>=0)renderClient(this.output.readPointer());}
});}
function enumerator(device){attach(method(device,4),{
 onEnter(args){this.output=args[1].toInt32()===0&&args[2].toInt32()===1?args[3]:null;},
 onLeave(result){
  if(!this.output)return;
  if(FAULT==='missing-endpoint'){
   if(result.toInt32()>=0&&!this.output.readPointer().isNull()){
    const p=this.output.readPointer();new NativeFunction(method(p,2),'uint32',['pointer'])(p);
   }
   this.output.writePointer(ptr(0));result.replace(ptr('0x80070490'));send({kind:'missing-render-endpoint'});
  }else if(result.toInt32()>=0)endpoint(this.output.readPointer());
 }
});}
Process.attachModuleObserver({onAdded(module){
 if(module.name.toLowerCase()==='combase.dll')attach(module.getExportByName('CoCreateInstance'),{
  onEnter(args){this.output=guid(args[0])==='9503debc2fe57c468e3dc4579291692e'?args[4]:null;},
  onLeave(result){if(this.output&&result.toInt32()>=0)enumerator(this.output.readPointer());}
 });
 if(module.name.toLowerCase()==='mmdevapi.dll')attach(module.getExportByName('ActivateAudioInterfaceAsync'),{
  onEnter(args){
   if(!args[0].readUtf16String().includes('Process_Loopback'))return;
   attach(method(args[3],3),{onEnter(args){
    attach(method(args[1],3),{
     onEnter(args){this.output=args[2];},
     onLeave(result){if(result.toInt32()>=0&&!this.output.readPointer().isNull())unknownClient(this.output.readPointer());}
    });
   }});
  }
 });
}});
