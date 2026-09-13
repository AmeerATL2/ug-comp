const socket = io();
const audio = document.getElementById('audio');
const list = document.getElementById('contestantList');
const hostPanel = document.getElementById('hostPanel');
const hostButtons = document.getElementById('hostButtons');
let isHost = false;
let latest = null;
let ignoreEvents = false;

socket.on('host', v => { isHost = !!v; hostPanel.classList.toggle('hidden', !isHost); renderHost(); });
socket.on('state', state => { latest = state; render(state); });

function render(s){
  document.getElementById('viewerCount').textContent = s.viewers;
  document.getElementById('slots').textContent = `${s.contestants.length}/10`;
  document.getElementById('status').textContent = s.playing ? 'PLAYING' : (s.current ? 'READY' : 'WAITING');
  const current = s.contestants.find(c=>c.id===s.current);
  document.getElementById('nowName').textContent = current ? current.name : 'No song loaded';
  document.getElementById('nowSong').textContent = current ? current.song : 'Waiting for the first contestant…';
  if(current && audio.dataset.id !== current.id){
    ignoreEvents=true; audio.src=current.url; audio.dataset.id=current.id; audio.load(); audio.currentTime=s.pausedAt||0; ignoreEvents=false;
  }
  if(current && s.playing){
    const target=Math.max(0,(Date.now()-s.startedAt)/1000);
    if(Math.abs(audio.currentTime-target)>1.2) audio.currentTime=target;
    audio.play().catch(()=>{});
  } else if(!s.playing && Math.abs(audio.currentTime-(s.pausedAt||0))>0.4){ audio.currentTime=s.pausedAt||0; audio.pause(); }
  list.innerHTML=s.contestants.length?s.contestants.map(c=>`<div class="person ${c.id===s.current?'active':''}"><span>${escapeHtml(c.name)}</span><span>${c.id===s.current?'● LIVE':'READY'}</span></div>`).join(''):'<p class="muted">No contestants yet.</p>';
  renderHost();
}
function renderHost(){ if(!latest || !isHost)return; hostButtons.innerHTML=latest.contestants.map(c=>`<button class="${c.id===latest.current?'active':''}" data-id="${c.id}">${escapeHtml(c.name)}</button>`).join(''); hostButtons.querySelectorAll('button').forEach(b=>b.onclick=()=>socket.emit('select',b.dataset.id)); }

document.getElementById('playBtn').onclick=()=>{ if(isHost) socket.emit('play'); };
document.getElementById('pauseBtn').onclick=()=>{ if(isHost) socket.emit('pause',audio.currentTime); };
document.getElementById('seek').oninput=e=>{ if(isHost) socket.emit('seek',Number(e.target.value)); };
audio.ontimeupdate=()=>{ const max=audio.duration||0; document.getElementById('time').textContent=formatTime(audio.currentTime); if(isHost && max)document.getElementById('seek').value=audio.currentTime; };
audio.onloadedmetadata=()=>document.getElementById('seek').max=audio.duration||100;
audio.onended=()=>{if(isHost) socket.emit('pause',audio.duration||0)};

document.getElementById('uploadForm').onsubmit=async e=>{
 e.preventDefault(); const msg=document.getElementById('uploadMsg'); const fd=new FormData(e.target); msg.textContent='Uploading…';
 try{const r=await fetch('/api/upload',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error);msg.textContent=`Uploaded: ${d.contestant.name}`;e.target.reset();}catch(err){msg.textContent=err.message;}
};
function formatTime(n){n=Math.floor(n||0);return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`}
function escapeHtml(x){return x.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
