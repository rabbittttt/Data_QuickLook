'use strict';

// A dedicated dialog lets catalog refreshes update the page without discarding
// per-file results. Existing chart draft protection still applies in app.js.
(() => {
  const dialog=document.querySelector('#importDialog');
  const entry=document.querySelector('#importButton');
  const input=document.querySelector('#importFiles');
  const start=document.querySelector('#importStart');
  const done=document.querySelector('#importDone');
  const status=document.querySelector('#importStatus');
  const list=document.querySelector('#importList');
  const progress=document.querySelector('#importProgress');
  let jobs=[],busy=false;
  const limit=256*1024*1024;
  const sizeLabel=size=>size<1024*1024?`${Math.ceil(size/1024)} KB`:`${(size/1024/1024).toFixed(1)} MB`;

  function renderJobs(){
    list.innerHTML=jobs.map(job=>`<li data-result="${job.result}"><strong>${esc(job.file.name)}</strong><small>${sizeLabel(job.file.size)}</small><span class="import-file-status">${esc(job.message)}</span></li>`).join('');
  }
  function updateJob(index,result,message){
    const job=jobs[index];job.result=result;job.message=message;
    const row=list.children[index];
    row.dataset.result=result;row.querySelector('.import-file-status').textContent=message;
  }

  entry.addEventListener('click',()=>{
    if(!dialog.open)dialog.showModal();
    if(busy)return;
    input.disabled=false;
    start.disabled=!jobs.some(job=>job.result==='pending');
  });

  input.addEventListener('change',()=>{
    jobs=Array.from(input.files).map(file=>{
      const error=!/\.(xlsx|xlsm)$/i.test(file.name)?'格式不支持；请另存为 .xlsx 或 .xlsm':
        !file.size?'文件为空，请检查原文件':file.size>limit?'超过 256 MB，请拆分文件后导入':'';
      return {file,result:error?'error':'pending',message:error||'等待导入'};
    });
    renderJobs();progress.hidden=true;start.hidden=false;
    const pending=jobs.filter(job=>job.result==='pending').length;
    start.disabled=!pending;
    status.textContent=jobs.length?`已选择 ${jobs.length} 个文件，${pending} 个可导入。`:'选择文件后开始导入。';
    done.textContent='关闭';
  });

  function confirmOverwrite(file,conflict,changed){
    const confirmation=document.querySelector('#importOverwriteDialog');
    document.querySelector('#importOverwriteName').textContent=conflict.name;
    document.querySelector('#importOverwriteSizes').textContent=`已有文件：${sizeLabel(conflict.size)} · 即将导入：${sizeLabel(file.size)}`;
    document.querySelector('#importOverwriteChanged').hidden=!changed;
    confirmation.returnValue='skip';
    return new Promise(resolve=>{
      confirmation.addEventListener('close',()=>resolve(confirmation.returnValue==='replace'),{once:true});
      confirmation.showModal();
      confirmation.querySelector('[value="skip"]').focus();
    });
  }

  function upload(file,index,replaceVersion=''){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      const params=new URLSearchParams({filename:file.name});
      if(replaceVersion)params.set('replace_version',replaceVersion);
      xhr.open('POST',apiUrl('import?'+params));
      xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.timeout=180000;
      xhr.upload.onprogress=event=>{
        if(!event.lengthComputable)return;
        const ratio=event.loaded/event.total;
        progress.value=index+ratio;
        updateJob(index,'uploading',ratio===1?'上传完成，正在校验与保存…':`正在上传 ${Math.round(ratio*100)}%`);
      };
      xhr.onload=()=>{
        let response;
        try{response=JSON.parse(xhr.responseText);}catch{return reject(Error('服务返回异常，请检查数据管理中的文件后再重试'));}
        if(xhr.status===409&&response.overwrite_required)resolve(response);
        else if(xhr.status>=200&&xhr.status<300&&response.saved)resolve(response);
        else reject(Error(response.error||`导入失败（${xhr.status}），请重试`));
      };
      xhr.onerror=()=>reject(Error('连接中断，请先到数据管理确认文件是否已保存，再重试'));
      xhr.ontimeout=()=>reject(Error('等待超时，请先到数据管理确认文件是否已保存，再重试'));
      xhr.send(file);
    });
  }

  start.addEventListener('click',async()=>{
    if(busy||!jobs.some(job=>job.result==='pending'))return;
    busy=true;input.disabled=true;start.disabled=true;progress.hidden=false;progress.max=jobs.length;progress.value=0;
    entry.textContent='导入中';done.textContent='后台继续';
    try{
      for(let index=0;index<jobs.length;index++){
        if(jobs[index].result!=='pending'){progress.value=index+1;continue;}
        status.textContent=`正在导入 ${index+1} / ${jobs.length}；关闭此窗口可继续使用页面。`;
        updateJob(index,'uploading','正在上传…');
        try{
          let replaceVersion='';
          while(true){
            const result=await upload(jobs[index].file,index,replaceVersion);
            if(!result.overwrite_required){
              updateJob(index,'saved',result.overwritten?'已覆盖原文件':`已保存：${result.name}`);
              break;
            }
            updateJob(index,'confirming','同名文件已存在，等待确认覆盖');
            entry.textContent='待确认';status.textContent=`正在等待确认：${jobs[index].file.name}`;
            const confirmed=await confirmOverwrite(jobs[index].file,result,!!replaceVersion);
            entry.textContent='导入中';
            if(!confirmed){updateJob(index,'skipped','已跳过，原文件保留');break;}
            replaceVersion=result.version;
            status.textContent=`正在覆盖 ${index+1} / ${jobs.length}…`;
            updateJob(index,'uploading','已确认，正在上传并覆盖…');
          }
        }catch(error){updateJob(index,'error',error.message);}
        progress.value=index+1;
      }
      const saved=jobs.filter(job=>job.result==='saved').length;
      const skipped=jobs.filter(job=>job.result==='skipped').length;
      const failed=jobs.filter(job=>job.result==='error').length;
      const summary=`已保存 ${saved} 个文件${skipped?`，已跳过 ${skipped} 个`:''}${failed?`，${failed} 个导入失败，请查看逐项提示`:''}。`;
      status.textContent=summary;
      if(saved){
        try{
          trackRequestedSync();
          status.textContent=summary+'已开始同步，页面会自动更新；正在编辑的图表会保留草稿。';
        }catch(error){status.textContent=summary+`启动同步失败：${error.message}。请点击页面“同步数据”，无需重新上传。`;}
      }
      if(!dialog.open)toast(status.textContent);
    }finally{
      busy=false;input.disabled=false;input.value='';start.hidden=true;done.textContent='完成';
      entry.innerHTML='导入<span class="action-detail">文件</span>';
    }
  });
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
})();
