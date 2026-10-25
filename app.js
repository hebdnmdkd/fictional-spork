(() => {
  const $ = (selector) => document.querySelector(selector);
  const REACTIONS = {
    poop: { label: 'какашку', icon: '💩' },
    money: { label: 'деньги', icon: '💸' },
    paramecium: { label: 'инфузорию-туфельку', icon: 'paramecium' },
    rose: { label: 'розу', icon: '🌹' },
  };
  const PARAMECIUM_SVG = '<svg viewBox="0 0 48 40" fill="none" aria-hidden="true"><path d="M8.4 22.8C8.4 14.7 15.6 8 25 8c7.9 0 14.1 4.4 14.1 10.7 0 7.1-7.5 13.2-16.2 13.2-8 0-14.5-3.2-14.5-9.1Z" fill="#88F2D2" stroke="#D2FFF3" stroke-width="1.4"/><path d="M9 18 4.7 15M12.1 13.1 9.5 9M17.2 9.4 16 5M23.3 8.1V3.7M29.2 8.7 31 4.5M34.2 11.3l3.1-3.2M38 16l4.2-1.7M38.9 22l4.3.7M35.7 28l3.4 2.5M30 31l1 4.2M23 32v4M16.7 30l-2.1 3.5M11.2 26.4l-4 1.6" stroke="#B3FFE9" stroke-width="1.4" stroke-linecap="round"/><circle cx="18" cy="18" r="2" fill="#3B9D8B"/><circle cx="28.5" cy="23.5" r="1.7" fill="#3B9D8B"/><path d="M20 25.5c2.1-2 4.2-2.7 6.4-2.2" stroke="#4DB59D" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function randomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let value = '';
    for (let i = 0; i < 6; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
  }
  function getRoomCode() {
    const params = new URLSearchParams(location.search);
    const requested = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const id = requested.length >= 4 ? requested : randomRoomCode();
    if (params.get('room') !== id) {
      const url = new URL(location.href);
      url.searchParams.set('room', id);
      history.replaceState({}, '', url.toString());
    }
    return id;
  }
  function getClientId() {
    try {
      let id = sessionStorage.getItem('watch-together-client-id');
      if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
        sessionStorage.setItem('watch-together-client-id', id);
      }
      return id;
    } catch {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
  }
  function getSavedName() {
    try {
      const saved = localStorage.getItem('watch-together-name');
      if (saved && saved.trim()) return saved.trim().slice(0, 28);
    } catch { /* storage can be disabled */ }
    return `Гость ${Math.floor(10 + Math.random() * 90)}`;
  }

  const roomId = getRoomCode();
  const clientId = getClientId();
  let displayName = getSavedName();
  let members = [];
  let activities = [];
  let roomState = { videoId: null, currentTime: 0, playing: false, updatedAt: Date.now(), master: null };
  let serverClockOffset = 0;
  let currentVideoId = null;
  let player = null;
  let playerReady = false;
  let pendingPacket = null;
  let expectedRemoteState = null;
  let suppressSeekUntil = 0;
  let lastObservedTime = null;
  let lastObservedAt = Date.now();
  let lastObservedPlaying = false;
  let lastTickAt = 0;
  let toastTimer = null;
  let apiLoadFailedTimer = null;

  $('#room-id').textContent = roomId;
  $('#display-name').value = displayName;

  function setConnection(status, text) {
    const pill = $('#connection-pill');
    pill.classList.remove('online', 'offline');
    if (status === 'online') pill.classList.add('online');
    if (status === 'offline') pill.classList.add('offline');
    $('#connection-text').textContent = text;
  }

  const eventSourceUrl = new URL('/events', location.origin);
  eventSourceUrl.searchParams.set('room', roomId);
  eventSourceUrl.searchParams.set('clientId', clientId);
  eventSourceUrl.searchParams.set('name', displayName);
  const eventSource = new EventSource(eventSourceUrl.toString());
  let resolveFirstConnection;
  const firstConnection = new Promise((resolve) => { resolveFirstConnection = resolve; });
  eventSource.addEventListener('open', () => {
    setConnection('online', 'Комната онлайн');
    resolveFirstConnection();
  });
  eventSource.addEventListener('error', () => {
    setConnection('offline', 'Переподключаемся…');
  });

  function updateServerClock(serverTime) {
    const receivedAt = Date.now();
    const timestamp = Number(serverTime);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const sample = timestamp - receivedAt;
      serverClockOffset = serverClockOffset === 0 ? sample : serverClockOffset * 0.75 + sample * 0.25;
    }
  }

  function currentRoomTime(packet) {
    const base = Number(packet.currentTime ?? packet.time ?? 0);
    const time = Number.isFinite(base) ? Math.max(0, base) : 0;
    if (!packet.playing) return time;
    const serverTime = Number(packet.serverTime ?? packet.updatedAt ?? Date.now() + serverClockOffset);
    const elapsed = Math.max(0, (Date.now() + serverClockOffset - serverTime) / 1000);
    return time + Math.min(elapsed, 30);
  }

  function updatePlaybackUi(playing, hasVideo = Boolean(currentVideoId)) {
    const chip = $('#playback-chip');
    chip.classList.toggle('playing', Boolean(playing && hasVideo));
    $('#playback-label').textContent = !hasVideo ? 'Ждём первое видео' : (playing ? 'Смотрим вместе' : 'Видео на паузе');
    $('#watch-status').textContent = !hasVideo ? 'ГОТОВ К ПРОСМОТРУ' : (playing ? 'СЕЙЧАС СМОТРИМ ВМЕСТЕ' : 'СЕЙЧАС НА ПАУЗЕ');
    $('#stage-label-text').textContent = !hasVideo ? 'КОМНАТА ГОТОВА' : (playing ? 'СМОТРИМ ВМЕСТЕ' : 'ВИДЕО НА ПАУЗЕ');
  }

  function showEmptyStage() {
    $('#empty-state').classList.remove('hidden');
    $('#stage-loading').classList.add('hidden');
    $('#stage-error').classList.add('hidden');
    $('#player-host').classList.remove('active-player');
    currentVideoId = null;
    $('#video-title').textContent = 'Пока ничего не играет';
    updatePlaybackUi(false, false);
  }
  function showVideoStage() {
    $('#empty-state').classList.add('hidden');
    $('#stage-error').classList.add('hidden');
    $('#player-host').classList.add('active-player');
    $('#stage-loading').classList.remove('hidden');
  }
  function setStageError(message) {
    $('#stage-loading').classList.add('hidden');
    $('#stage-error').textContent = message;
    $('#stage-error').classList.remove('hidden');
  }
  function updateVideoCaption() {
    if (!currentVideoId) return;
    try {
      const data = player && player.getVideoData ? player.getVideoData() : null;
      if (data && data.title) {
        $('#video-title').textContent = data.title;
        return;
      }
    } catch { /* player may not have loaded its metadata yet */ }
    $('#video-title').textContent = 'Видео из YouTube · ' + currentVideoId;
  }

  function markExpectedRemoteState(state) {
    expectedRemoteState = { state, expiresAt: Date.now() + 5500 };
  }
  function targetTime(packet) {
    return currentRoomTime(packet);
  }
  function applyPacketToPlayer(packet, forceVideo = false, localAction = false) {
    if (!player || !playerReady || !packet || !packet.videoId) return;
    const videoId = packet.videoId;
    const playing = Boolean(packet.playing);
    const time = targetTime(packet);
    const mustLoad = forceVideo || videoId !== currentVideoId;
    if (mustLoad) {
      currentVideoId = videoId;
      $('#stage-loading').classList.add('hidden');
      if (playing) {
        if (!localAction) markExpectedRemoteState(1);
        player.loadVideoById({ videoId, startSeconds: time });
      } else {
        player.cueVideoById({ videoId, startSeconds: time });
      }
      updatePlaybackUi(playing, true);
      setTimeout(updateVideoCaption, 450);
      return;
    }

    let state = -1;
    let actualTime = 0;
    try {
      state = player.getPlayerState();
      actualTime = player.getCurrentTime();
    } catch { /* player may still be initializing */ }
    if (Number.isFinite(actualTime) && Math.abs(actualTime - time) > 1.35) {
      suppressSeekUntil = Date.now() + 900;
      try { player.seekTo(time, true); } catch { /* ignore until the player is ready */ }
    }
    if (playing && state !== 1 && state !== 3) {
      if (!localAction) markExpectedRemoteState(1);
      try { player.playVideo(); } catch { /* ignore until the player is ready */ }
    } else if (!playing && (state === 1 || state === 3)) {
      if (!localAction) markExpectedRemoteState(2);
      try { player.pauseVideo(); } catch { /* ignore until the player is ready */ }
    }
    updatePlaybackUi(playing, true);
    setTimeout(updateVideoCaption, 250);
  }

  function loadPacketIntoPlayer(packet, options = {}) {
    if (!packet || !packet.videoId) return;
    const localAction = Boolean(options.localAction);
    const forceVideo = Boolean(options.forceVideo);
    showVideoStage();
    currentVideoId = packet.videoId;
    updatePlaybackUi(Boolean(packet.playing), true);

    if (!window.YT || !window.YT.Player) {
      pendingPacket = { packet, localAction, forceVideo: true };
      return;
    }
    if (!player) {
      pendingPacket = { packet, localAction, forceVideo: true };
      player = new window.YT.Player('player-host', {
        width: '100%',
        height: '100%',
        videoId: packet.videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          playsinline: 1,
          rel: 0,
          fs: 1,
          iv_load_policy: 3,
          modestbranding: 1,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            playerReady = true;
            $('#stage-loading').classList.add('hidden');
            const queued = pendingPacket;
            pendingPacket = null;
            if (queued) applyPacketToPlayer(queued.packet, true, queued.localAction);
            updateVideoCaption();
          },
          onStateChange: onPlayerStateChange,
          onError: (event) => {
            const messages = {
              2: 'Ссылка на видео некорректна. Проверь её и попробуй ещё раз.',
              5: 'Не удалось запустить HTML5-плеер YouTube.',
              100: 'Видео не найдено или оно стало приватным.',
              101: 'Это видео нельзя встроить на сайт. Попробуй другое или открой его на YouTube.',
              150: 'Это видео нельзя встроить на сайт. Попробуй другое или открой его на YouTube.',
            };
            setStageError(messages[event.data] || 'Не получилось загрузить это видео. Попробуй другую ссылку.');
          },
        },
      });
      return;
    }
    if (!playerReady) {
      pendingPacket = { packet, localAction, forceVideo: true };
      return;
    }
    applyPacketToPlayer(packet, forceVideo, localAction);
  }

  window.onYouTubeIframeAPIReady = () => {
    const queued = pendingPacket;
    if (queued) loadPacketIntoPlayer(queued.packet, { localAction: queued.localAction, forceVideo: true });
  };
  const youtubeApi = document.createElement('script');
  youtubeApi.src = 'https://www.youtube.com/iframe_api';
  youtubeApi.async = true;
  document.head.appendChild(youtubeApi);
  apiLoadFailedTimer = setTimeout(() => {
    if (currentVideoId && (!window.YT || !window.YT.Player)) {
      setStageError('Не удалось подключить YouTube. Проверь интернет и попробуй обновить страницу.');
    }
  }, 12000);

  function onPlayerStateChange(event) {
    const state = event.data;
    const now = Date.now();
    if (expectedRemoteState) {
      if (now <= expectedRemoteState.expiresAt && state === expectedRemoteState.state) {
        expectedRemoteState = null;
        updatePlaybackUi(state === 1, true);
        return;
      }
      if (now <= expectedRemoteState.expiresAt && expectedRemoteState.state === 1 && state === 3) return;
      if (now > expectedRemoteState.expiresAt) expectedRemoteState = null;
    }
    if (state === 1) sendPlayback(true);
    else if (state === 2) sendPlayback(false);
    else if (state === 0) sendPlayback(false);
    if (state === 1 || state === 2 || state === 0) {
      lastObservedTime = safePlayerTime();
      lastObservedAt = now;
      lastObservedPlaying = state === 1;
      updatePlaybackUi(state === 1, Boolean(currentVideoId));
      setTimeout(updateVideoCaption, 250);
    }
  }

  function safePlayerTime() {
    try {
      const time = player && player.getCurrentTime ? player.getCurrentTime() : 0;
      return Number.isFinite(time) ? time : 0;
    } catch { return 0; }
  }
  function sendPlayback(playing, time = safePlayerTime()) {
    if (!currentVideoId) return;
    roomState = { ...roomState, videoId: currentVideoId, currentTime: Math.max(0, Number(time) || 0), playing, updatedAt: Date.now() + serverClockOffset, master: clientId };
    updatePlaybackUi(playing, true);
    postCommand('playback', { time: roomState.currentTime, playing });
  }

  function parseYouTubeVideoId(value) {
    const raw = String(value || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    let url;
    try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let id = null;
    if (host === 'youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube.com')) {
      if (url.pathname === '/watch' || url.pathname === '/') id = url.searchParams.get('v');
      if (!id) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  function waitForConnection() {
    if (eventSource.readyState === EventSource.OPEN) return Promise.resolve();
    return Promise.race([
      firstConnection,
      new Promise((resolve) => setTimeout(resolve, 4500)),
    ]);
  }
  async function postCommand(type, details = {}) {
    await waitForConnection();
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomId, clientId, type, ...details }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) toast('Комната переподключается — попробуй ещё раз.');
        else toast(data.error || 'Не удалось отправить событие.');
      }
    } catch {
      setConnection('offline', 'Нет соединения');
      toast('Похоже, соединение пропало. Попробуй ещё раз.');
    }
  }

  function normalizePacket(data) {
    return {
      videoId: data.videoId || roomState.videoId,
      currentTime: Number(data.currentTime ?? data.time ?? 0),
      playing: Boolean(data.playing),
      serverTime: Number(data.serverTime ?? data.updatedAt ?? Date.now() + serverClockOffset),
      master: data.master ?? roomState.master,
      senderId: data.senderId,
    };
  }
  function setRemoteRoomState(packet) {
    roomState = {
      ...roomState,
      videoId: packet.videoId,
      currentTime: packet.currentTime,
      playing: packet.playing,
      updatedAt: packet.serverTime,
      master: packet.master ?? roomState.master,
    };
    updatePlaybackUi(packet.playing, Boolean(packet.videoId));
  }

  eventSource.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    updateServerClock(data.serverTime);
    members = data.users || [];
    roomState = data.state || roomState;
    if (roomState.videoId) {
      const packet = normalizePacket({ ...roomState, serverTime: roomState.updatedAt || data.serverTime, master: roomState.master });
      setRemoteRoomState(packet);
      loadPacketIntoPlayer(packet, { forceVideo: true });
    } else {
      showEmptyStage();
    }
    renderMembers();
  });
  eventSource.addEventListener('presence', (event) => {
    const data = JSON.parse(event.data);
    members = data.users || [];
    if ('master' in data) roomState.master = data.master;
    renderMembers();
  });
  eventSource.addEventListener('video', (event) => {
    const data = JSON.parse(event.data);
    updateServerClock(data.serverTime);
    if (data.senderId === clientId) return;
    const packet = normalizePacket(data);
    packet.master = data.senderId;
    setRemoteRoomState(packet);
    loadPacketIntoPlayer(packet, { forceVideo: true });
    if (data.senderName) toast(`${data.senderName} добавил(а) видео`);
  });
  eventSource.addEventListener('playback', (event) => {
    const data = JSON.parse(event.data);
    updateServerClock(data.serverTime);
    if (data.senderId === clientId) return;
    const packet = normalizePacket(data);
    packet.master = data.senderId;
    setRemoteRoomState(packet);
    loadPacketIntoPlayer(packet, { forceVideo: false });
  });
  eventSource.addEventListener('tick', (event) => {
    const data = JSON.parse(event.data);
    updateServerClock(data.serverTime);
    if (data.senderId === clientId) return;
    const packet = normalizePacket(data);
    packet.master = roomState.master;
    setRemoteRoomState(packet);
    loadPacketIntoPlayer(packet, { forceVideo: false });
  });
  eventSource.addEventListener('reaction', (event) => {
    const data = JSON.parse(event.data);
    if (data.senderId === clientId) return;
    receiveReaction(data);
  });

  $('#video-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#youtube-url');
    const videoId = parseYouTubeVideoId(input.value);
    if (!videoId) {
      input.focus();
      toast('Не нашёл ссылку. Вставь обычную ссылку на YouTube-видео.');
      return;
    }
    const packet = {
      videoId,
      currentTime: 0,
      time: 0,
      playing: true,
      serverTime: Date.now() + serverClockOffset,
      master: clientId,
    };
    roomState = { ...roomState, videoId, currentTime: 0, playing: true, updatedAt: packet.serverTime, master: clientId };
    loadPacketIntoPlayer(packet, { localAction: true, forceVideo: true });
    postCommand('video', { videoId });
    input.value = '';
    toast('Видео отправлено в комнату');
  });

  function emojiForReaction(type) {
    return REACTIONS[type] ? REACTIONS[type].icon : '✦';
  }
  function createReactionIcon(type, className = '') {
    const element = document.createElement('span');
    element.className = className;
    if (type === 'paramecium') element.innerHTML = PARAMECIUM_SVG;
    else element.textContent = emojiForReaction(type);
    return element;
  }
  function spawnReaction(type, name) {
    const layer = $('#reaction-floats');
    const item = document.createElement('div');
    item.className = 'floating-reaction';
    item.style.setProperty('--float-x', `${22 + Math.random() * 56}%`);
    item.style.setProperty('--float-bottom', `${10 + Math.random() * 16}%`);
    const icon = createReactionIcon(type, 'floating-reaction-icon');
    const sender = document.createElement('span');
    sender.className = 'floating-reaction-name';
    sender.textContent = name || 'Друг';
    item.append(icon, sender);
    layer.append(item);
    setTimeout(() => item.remove(), 3600);
  }
  function getInitials(name) {
    const words = String(name || 'Г').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }
  function addActivity(data) {
    if (!REACTIONS[data.reaction]) return;
    activities.unshift({
      id: data.id || `${Date.now()}-${Math.random()}`,
      reaction: data.reaction,
      senderName: data.senderName || 'Друг',
      senderId: data.senderId,
      createdAt: data.createdAt || Date.now(),
    });
    activities = activities.slice(0, 7);
    renderActivities();
  }
  function receiveReaction(data) {
    addActivity(data);
    spawnReaction(data.reaction, data.senderName);
  }
  document.querySelectorAll('[data-reaction]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.reaction;
      if (!REACTIONS[type]) return;
      const event = { reaction: type, senderName: displayName, senderId: clientId, createdAt: Date.now() };
      addActivity(event);
      spawnReaction(type, displayName);
      postCommand('reaction', { reaction: type });
    });
  });

  function hashHue(value) {
    let hash = 0;
    for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return Math.abs(hash) % 360;
  }
  function renderMembers() {
    const list = $('#member-list');
    list.replaceChildren();
    const ordered = [...members].sort((a, b) => (a.id === clientId ? -1 : 0) - (b.id === clientId ? -1 : 0));
    $('#member-count').textContent = String(ordered.length || 1);
    $('#friend-hint').classList.toggle('hidden', ordered.length > 1);
    if (!ordered.length) {
      members = [{ id: clientId, name: displayName }];
      return renderMembers();
    }
    ordered.slice(0, 6).forEach((member) => {
      const row = document.createElement('div');
      row.className = 'member-item';
      const avatar = document.createElement('span');
      avatar.className = 'member-avatar';
      avatar.style.setProperty('--avatar-hue', String(hashHue(member.name)));
      avatar.textContent = getInitials(member.name);
      const details = document.createElement('span');
      details.className = 'member-details';
      const name = document.createElement('strong');
      name.className = 'member-name';
      name.textContent = member.name || 'Гость';
      const role = document.createElement('small');
      role.className = 'member-role';
      role.textContent = member.id === clientId ? 'Ты в этой комнате' : 'Смотрит вместе с тобой';
      details.append(name, role);
      row.append(avatar, details);
      if (member.id === clientId) {
        const you = document.createElement('span');
        you.className = 'member-you';
        you.textContent = 'ЭТО ТЫ';
        row.append(you);
      }
      list.append(row);
    });
  }
  function renderActivities() {
    const feed = $('#activity-feed');
    feed.replaceChildren();
    if (!activities.length) {
      const empty = document.createElement('div');
      empty.className = 'feed-empty';
      const icon = document.createElement('span');
      icon.className = 'feed-empty-icon';
      icon.textContent = '✦';
      const text = document.createElement('p');
      text.innerHTML = 'Реакции появятся здесь,<br>как только начнётся веселье.';
      empty.append(icon, text);
      feed.append(empty);
      return;
    }
    activities.forEach((activity) => {
      const row = document.createElement('div');
      row.className = 'activity-item';
      const avatar = document.createElement('span');
      avatar.className = 'activity-avatar';
      avatar.textContent = getInitials(activity.senderName);
      const text = document.createElement('span');
      text.className = 'activity-text';
      const sender = document.createElement('strong');
      sender.textContent = activity.senderName;
      text.append(sender, document.createTextNode(` отправил(а) ${REACTIONS[activity.reaction].label}`));
      const icon = createReactionIcon(activity.reaction, 'activity-emoji');
      row.append(avatar, text, icon);
      feed.append(row);
    });
  }

  $('#name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const newName = $('#display-name').value.trim().slice(0, 28);
    if (!newName) {
      $('#display-name').value = displayName;
      toast('Имя не должно быть пустым');
      return;
    }
    displayName = newName;
    try { localStorage.setItem('watch-together-name', displayName); } catch { /* ignore */ }
    const existing = members.find((member) => member.id === clientId);
    if (existing) existing.name = displayName;
    renderMembers();
    postCommand('name', { name: displayName });
    toast(`Теперь ты — ${displayName}`);
  });

  async function copyInvite() {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('Ссылка на комнату скопирована');
    } catch {
      const helper = document.createElement('textarea');
      helper.value = url.toString();
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.append(helper);
      helper.select();
      const copied = document.execCommand('copy');
      helper.remove();
      toast(copied ? 'Ссылка на комнату скопирована' : 'Скопируй ссылку из адресной строки');
    }
  }
  $('#copy-invite').addEventListener('click', copyInvite);
  $('#copy-invite-side').addEventListener('click', copyInvite);

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  // The active controller sends short server-pushed clock updates; seek jumps are sent by whoever seeks.
  setInterval(() => {
    if (!playerReady || !currentVideoId) return;
    let state;
    try { state = player.getPlayerState(); } catch { return; }
    if (state !== 1 && state !== 2) return;
    const now = Date.now();
    const current = safePlayerTime();
    const elapsed = Math.max(0, (now - lastObservedAt) / 1000);
    const expected = lastObservedTime === null ? current : lastObservedTime + (lastObservedPlaying ? elapsed : 0);
    const jump = Math.abs(current - expected) > 1.55;

    if (jump && now > suppressSeekUntil) {
      sendPlayback(state === 1, current);
    } else if (state === 1 && roomState.master === clientId && now - lastTickAt > 2200) {
      roomState.currentTime = current;
      roomState.updatedAt = now + serverClockOffset;
      postCommand('tick', { time: current });
      lastTickAt = now;
    }
    lastObservedTime = current;
    lastObservedAt = now;
    lastObservedPlaying = state === 1;
  }, 650);

  renderMembers();
  renderActivities();
  updatePlaybackUi(false, false);
})();
