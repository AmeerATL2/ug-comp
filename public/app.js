const socket = io();
const audio = document.getElementById('audio');
const list = document.getElementById('contestantList');
const hostPanel = document.getElementById('hostPanel');
const hostButtons = document.getElementById('hostButtons');
let isHost = false;
let latest = null;
let countdownTimer = null;
let hasVoted = false;
let chatBottom = true;

socket.on('host', v => { isHost = !!v; hostPanel.classList.toggle('hidden', !isHost); renderHost(); });
socket.on('capacity', data => alert(data.message));
socket.on('state', state => { latest = state; render(state); });

document.getElementById('chatMessages').addEventListener('scroll', e => {
  const el = e.currentTarget;
  chatBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
});

function render(s){
  document.getElementById('viewerCount').textContent = s.viewers;
  document.getElementById('slots').textContent = `${s.contestants.length}/10`;
  document.getElementById('status').textContent = s.voting ? 'VOTING' : (s.playing ? 'PLAYING' : (s.current ? 'READY' : 'WAITING'));
  document.getElementById('roundLabel').textContent = s.round ? `ROUND ${s.round}` : 'ROUND 0';

  const current = s.contestants.find(c=>c.id===s.current);
  document.getElementById('nowName').textContent = current ? current.name : 'No song loaded';
  document.getElementById('nowSocial').textContent = current?.social || '';
  document.getElementById('nowSong').textContent = current ? current.song : 'Waiting for the first contestant…';
  const cover = document.getElementById('cover');
  if(current?.coverUrl){ cover.innerHTML = `<img src="${current.coverUrl}" alt="Cover art">`; cover.classList.add('has-image'); }
  else { cover.classList.remove('has-image'); cover.innerHTML='UG<br>COMP'; }

  if(current && audio.dataset.id !== current.id){ audio.src=current.url; audio.dataset.id=current.id; audio.load(); audio.currentTime=s.pausedAt||0; }
  if(current && s.playing){
    const target=Math.max(0,(Date.now()-s.startedAt)/1000);
    if(Math.abs(audio.currentTime-target)>1.2) audio.currentTime=target;
    audio.play().catch(()=>{});
  } else if(!s.playing){
    if(Math.abs(audio.currentTime-(s.pausedAt||0))>0.4) audio.currentTime=s.pausedAt||0;
    audio.pause();
  }

  list.innerHTML=s.contestants.length?s.contestants.map(c=>`
    <div class="person ${c.id===s.current?'active':''}">
      <div class="person-main"><div class="mini-cover">${c.coverUrl?`<img src="${c.coverUrl}" alt="">`:'UG'}</div><div><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.social || '')}</small></div></div>
      <span class="status-${c.status.toLowerCase()}">${c.status}</span>
    </div>`).join(''):'<p class="muted">No contestants yet.</p>';

  renderBattle(s);
  renderScoreboard(s);
  renderChat(s);
  renderHost();
}

function renderBattle(s){
  const a=s.contestants.find(c=>c.id===s.battle.championId);
  const b=s.contestants.find(c=>c.id===s.battle.challengerId);
  renderFighter('fighterA',a,'CHAMPION'); renderFighter('fighterB',b,'CHALLENGER');
  const panel=document.getElementById('votePanel');
  document.getElementById('notVoting').classList.toggle('hidden',!!s.voting);
  panel.classList.toggle('hidden',!s.voting || !a || !b);
  if(!a || !b) return;
  document.getElementById('voteNameA').textContent=a.name;
  document.getElementById('voteNameB').textContent=b.name;
  const pa=s.voteData.percentages[a.id]||0, pb=s.voteData.percentages[b.id]||0;
  document.getElementById('votePctA').textContent=`${pa}%`;
  document.getElementById('votePctB').textContent=`${pb}%`;
  document.getElementById('voteBarA').style.width=`${pa}%`;
  document.getElementById('voteBarB').style.width=`${pb}%`;
  document.getElementById('voteBtnA').disabled=hasVoted;
  document.getElementById('voteBtnB').disabled=hasVoted;
  document.getElementById('voteMsg').textContent=hasVoted?'Vote submitted. Watch the scoreboard!':'One vote per connected viewer.';
  updateCountdown(s.votingEndsAt);
}
function renderFighter(id,c,tag){
  const el=document.getElementById(id);
  if(!c){el.innerHTML=`<div class="fighter-cover">UG</div><div><span class="tag">${tag}</span><h3>Waiting</h3><p>Next contestant needed</p></div>`;return;}
  el.innerHTML=`<div class="fighter-cover">${c.coverUrl?`<img src="${c.coverUrl}" alt="">`:'UG'}</div><div><span class="tag">${tag}</span><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.social||'')}</p></div>`;
}
function renderScoreboard(s){
  document.getElementById('scoreboard').innerHTML=s.contestants.map(c=>`<tr><td>${c.order}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.social||'—')}</td><td>${c.wins}</td><td>${c.losses}</td><td><span class="status-${c.status.toLowerCase()}">${c.status}</span></td><td>${isHost?`<button class="remove-btn" data-remove="${c.id}">REMOVE</button>`:''}</td></tr>`).join('');
  document.querySelectorAll('[data-remove]').forEach(btn=>btn.onclick=()=>{const c=s.contestants.find(x=>x.id===btn.dataset.remove);if(c&&confirm(`Remove ${c.name} from UG COMP?`)) socket.emit('remove-contestant',c.id);});
}
function renderChat(s){
  const el=document.getElementById('chatMessages');
  const oldBottom=chatBottom;
  el.innerHTML=s.chat.map(m=>`<div class="chat-line"><span>${escapeHtml(m.guest)}</span><p>${escapeHtml(m.text)}</p></div>`).join('') || '<p class="muted">Chat is empty. Be the first to say something.</p>';
  if(oldBottom) el.scrollTop=el.scrollHeight;
}
function renderHost(){
  if(!latest || !isHost) return;
  hostButtons.innerHTML=latest.contestants.map(c=>`<div class="host-contestant"><button class="${c.id===latest.current?'active':''}" data-id="${c.id}">${escapeHtml(c.name)}</button><button class="remove-btn" data-host-remove="${c.id}">REMOVE</button></div>`).join('');
  hostButtons.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>socket.emit('select',b.dataset.id));
  hostButtons.querySelectorAll('[data-host-remove]').forEach(b=>b.onclick=()=>{const c=latest.contestants.find(x=>x.id===b.dataset.hostRemove);if(c&&confirm(`Remove ${c.name} from UG COMP?`))socket.emit('remove-contestant',c.id);});
  document.getElementById('startVoteBtn').disabled=latest.voting || !latest.battle.championId || !latest.battle.challengerId;
  document.getElementById('endVoteBtn').disabled=!latest.voting;
}
function updateCountdown(endsAt){
  clearInterval(countdownTimer);
  const tick=()=>{
    if(!endsAt){document.getElementById('countdown').textContent='0:00';return;}
    const left=Math.max(0,Math.ceil((endsAt-Date.now())/1000));
    document.getElementById('countdown').textContent=`0:${String(left).padStart(2,'0')}`;
    if(left<=0) clearInterval(countdownTimer);
  };
  tick(); countdownTimer=setInterval(tick,250);
}

document.getElementById('playBtn').onclick=()=>{if(isHost)socket.emit('play');};
document.getElementById('pauseBtn').onclick=()=>{if(isHost)socket.emit('pause',audio.currentTime);};
document.getElementById('seek').oninput=e=>{if(isHost)socket.emit('seek',Number(e.target.value));};
audio.ontimeupdate=()=>{const max=audio.duration||0;document.getElementById('time').textContent=formatTime(audio.currentTime);if(isHost&&max)document.getElementById('seek').value=audio.currentTime;};
audio.onloadedmetadata=()=>document.getElementById('seek').max=audio.duration||100;
audio.onended=()=>{if(isHost)socket.emit('pause',audio.duration||0)};

document.getElementById('voteBtnA').onclick=()=>{if(latest?.voting&&!hasVoted){socket.emit('vote',latest.battle.championId);hasVoted=true;}};
document.getElementById('voteBtnB').onclick=()=>{if(latest?.voting&&!hasVoted){socket.emit('vote',latest.battle.challengerId);hasVoted=true;}};
document.getElementById('startVoteBtn').onclick=()=>{if(isHost)socket.emit('start-vote');hasVoted=false;};
document.getElementById('endVoteBtn').onclick=()=>{if(isHost)socket.emit('end-vote');};

socket.on('state',s=>{ if(!s.voting) hasVoted=false; });

document.getElementById('uploadForm').onsubmit=async e=>{
  e.preventDefault(); const msg=document.getElementById('uploadMsg'); const fd=new FormData(e.target); msg.textContent='Uploading…';
  try{const r=await fetch('/api/upload',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error);msg.textContent=`Uploaded: ${d.contestant.name}`;e.target.reset();}catch(err){msg.textContent=err.message;}
};

document.getElementById('chatForm').onsubmit=e=>{e.preventDefault();const input=document.getElementById('chatInput');const text=input.value.trim();if(text){socket.emit('chat',text);input.value='';input.focus();}};

function formatTime(n){n=Math.floor(n||0);return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`}
function escapeHtml(x){return String(x).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
