export class SnapshotCache {
  constructor(load,{ttl=15000,now=Date.now,onUpdate=async()=>{},maxEntries=24}={}){
    this.load=load;this.ttl=ttl;this.now=now;this.onUpdate=onUpdate;this.maxEntries=maxEntries;
    this.entries=new Map();this.pending=new Map();this.generation=0;
  }
  key(query){return JSON.stringify(Object.fromEntries(Object.entries(query).sort(([a],[b])=>a.localeCompare(b))));}
  seed(query,data,syncedAt){this.entries.set(this.key(query),{data,syncedAt,error:null});}
  clear(){this.generation++;this.entries.clear();this.pending.clear();}
  async refresh(query){
    const key=this.key(query);
    if(this.pending.has(key))return this.pending.get(key);
    const generation=this.generation;
    const request=Promise.resolve().then(()=>this.load(query)).then(async data=>{
      const entry={data,syncedAt:new Date(this.now()).toISOString(),error:null};
      if(generation!==this.generation)return entry;
      this.entries.delete(key);this.entries.set(key,entry);
      while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
      await this.onUpdate(query,entry);return entry;
    }).catch(error=>{const entry=this.entries.get(key);if(entry&&generation===this.generation)entry.error=error.message;throw error;}).finally(()=>{if(this.pending.get(key)===request)this.pending.delete(key);});
    this.pending.set(key,request);return request;
  }
  async read(query){
    const key=this.key(query);let entry=this.entries.get(key);
    if(!entry)entry=await this.refresh(query);
    else if(this.now()-Date.parse(entry.syncedAt)>=this.ttl)void this.refresh(query).catch(()=>{});
    return {...entry.data,sync:{syncedAt:entry.syncedAt,refreshing:this.pending.has(key),error:entry.error}};
  }
}
