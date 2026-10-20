export function createLimiter(limit){
  let active=0;
  const queue=[];
  return async function limited(work){
    if(active>=limit)await new Promise(resolve=>queue.push(resolve));
    else active++;
    try{return await work();}
    finally{
      if(queue.length)queue.shift()();
      else active--;
    }
  };
}
export function createSerialQueue(){
  let tail=Promise.resolve();
  return work=>{
    const result=tail.then(work);
    tail=result.catch(()=>{});
    return result;
  };
}
