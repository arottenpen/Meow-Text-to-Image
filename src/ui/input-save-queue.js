// Update drafts synchronously; keep host persistence out of the typing handler.
export function createInputSaveQueue({save,onError=()=>{},delayMs=300,maxWaitMs=1500,setTimer=setTimeout,clearTimer=clearTimeout}){
    let idle=null,deadline=null,dirty=false,depth=0,composing=false,disposed=false;
    const clear=()=>{if(idle!==null)clearTimer(idle);if(deadline!==null)clearTimer(deadline);idle=deadline=null;};
    const flush=()=>{
        clear();if(!dirty)return;
        dirty=false;try{save();}catch(error){dirty=true;onError(error);}
    };
    const arm=()=>{
        if(composing||!dirty)return;
        if(idle!==null)clearTimer(idle);idle=setTimer(flush,delayMs);
        if(deadline===null)deadline=setTimer(flush,maxWaitMs);
    };
    return {
        input(change){depth++;try{return change();}finally{depth--; }},
        request(){dirty=true;if(disposed||!depth)flush();else arm();},
        flush,
        compositionStart(){composing=true;clear();},
        compositionEnd(){composing=false;arm();},
        dispose(){disposed=true;composing=false;flush();},
    };
}
