// Store message objects, not indices which can point at another message later.
export function createRenderScheduler({getScope,render,delayMs=80,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}){
    let timer=null,key,chat,full=false;const dirty=new Set();
    const cancel=()=>{if(timer!==null)clearTimer(timer);timer=null;dirty.clear();full=false;};
    const flush=()=>{
        timer=null;const scope=getScope();
        if(scope.key!==key||scope.chat!==chat){cancel();return;}
        const targets=full?null:[...dirty].filter(message=>scope.chat.includes(message));
        dirty.clear();full=false;
        try{if(targets===null||targets.length)render(targets);}catch(error){onError(error);}
    };
    return {cancel,schedule(message){
        const scope=getScope();if(scope.key!==key||scope.chat!==chat){cancel();key=scope.key;chat=scope.chat;}
        if(message==null){full=true;dirty.clear();}else if(!full)dirty.add(message);
        // Do not restart the timer: continuous updates must still paint.
        if(timer===null)timer=setTimer(flush,delayMs);
    }};
}