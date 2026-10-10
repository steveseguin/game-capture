'use strict';
// Observe only event handles created directly by the packaged executable.
// Retained handles are reported by call site; no system call behavior is changed.
const app=Process.getModuleByName('game-capture.exe');
const kernel=Process.getModuleByName('kernelbase.dll');
const handles=new Map();let created=0,closed=0;
for(const name of ['CreateEventW','CreateEventExW','CreateMutexW','CreateMutexExW','OpenMutexW']) {
  const address=kernel.findExportByName(name);if(!address)continue;
  Interceptor.attach(address,{
    onEnter(){
      this.site=this.returnAddress.compare(app.base)>=0&&this.returnAddress.compare(app.base.add(app.size))<0
        ?this.returnAddress.sub(app.base).toString():null;
      if(name.includes('Mutex'))this.site=Thread.backtrace(this.context,Backtracer.ACCURATE).slice(0,12)
        .map(p=>{const m=Process.findModuleByAddress(p);return m?m.name+'+'+p.sub(m.base):p.toString();}).join(' > ');
    },
    onLeave(result){if(this.site&&!result.isNull()){
      const id=result.toString();handles.set(id,{handle:id,api:name,site:this.site});created++;
      send({kind:'event-created',handle:id,api:name,site:this.site});
    }}
  });
}
Interceptor.attach(kernel.getExportByName('CloseHandle'),{
  onEnter(args){this.id=args[0].toString();this.tracked=handles.has(this.id);},
  onLeave(result){if(this.tracked&&!result.isNull()){
    handles.delete(this.id);closed++;send({kind:'event-closed',handle:this.id});
  }}
});
const comBalance=new Map();
const combase=Process.getModuleByName('combase.dll');
for(const name of ['CoInitializeEx','CoUninitialize']){
  const address=combase.findExportByName(name);if(!address)continue;
  Interceptor.attach(address,{
    onEnter(){this.owned=this.returnAddress.compare(app.base)>=0&&this.returnAddress.compare(app.base.add(app.size))<0;
      this.thread=Process.getCurrentThreadId();},
    onLeave(result){if(this.owned&&(name==='CoUninitialize'||result.toInt32()>=0)){
      const delta=name==='CoInitializeEx'?1:-1;comBalance.set(this.thread,(comBalance.get(this.thread)||0)+delta);
      send({kind:'com-balance',api:name,thread:this.thread,balance:comBalance.get(this.thread)});
    }}
  });
}
rpc.exports.snapshot=()=>({created,closed,outstanding:[...handles.values()],comBalance:Object.fromEntries(comBalance)});
