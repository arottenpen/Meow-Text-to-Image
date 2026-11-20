// A trailing throttle: continuous tokens cannot postpone the next scan forever.
// Keep at most one scan in flight, including asynchronous macro reads.
export function createStreamScheduler(run,{delayMs=80,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}={}){
    let timer=null,running=false,dirty=false;
    const arm=()=>{if(timer===null&&!running&&dirty)timer=setTimer(flush,delayMs);};
    const flush=async()=>{
        timer=null;if(!dirty)return;
        dirty=false;running=true;
        try{await run();}catch(error){onError(error);}
        finally{running=false;arm();}
    };
    return {
        schedule(){dirty=true;arm();},
        cancel(){if(timer!==null)clearTimer(timer);timer=null;dirty=false;},
    };
}
// Only suppress mutations confined to the active streaming floor. Structural
// changes to #chat and edits to history still need the ordinary render path.
export function streamOnlyMutations(records,streamFloor){
    return !!streamFloor&&records.length>0&&records.every(record=>{
        const target=record.target?.nodeType===3?record.target.parentElement:record.target;
        return target?.closest?.('.mes')===streamFloor&&!(record.type==='attributes'&&record.attributeName==='mesid');
    });
}
