const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const { userDb, groupDb, messageDb, friendDb, inviteDb } = require('./database');

// BugReporter opcional — funciona local, ignora erros na nuvem
let bugReporter = { reportInfo: () => {}, reportBug: () => {}, reportWarning: () => {}, getSummary: () => {} };
try {
  const BugReporter = require('./bug-reporter');
  bugReporter = new BugReporter();
} catch (_) {}

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mapas em memória
// userId  -> { socketId, username, status, voiceChannelId }
const onlineUsers = new Map();
// socketId -> userId
const socketToUser = new Map();

// ─── Utilitários ───────────────────────────────────────────────────────────

async function broadcastOnlineUsers() {
  const list = [];
  for (const [uid, info] of onlineUsers) {
    const user = await userDb.findUser({ userId: uid }).catch(() => null);
    if (user) list.push({ ...user, status: info.status });
  }
  io.emit('online-users-list', { users: list });
}

// ─── Rotas HTTP ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', onlineUsers: onlineUsers.size }));

app.get('/bugs/latest', (_req, res) => {
  const latest = BugReporter.getLatestReport();
  latest
    ? res.type('text/plain').send(latest.content)
    : res.json({ message: 'Nenhum relatório encontrado' });
});

app.get('/bugs', (_req, res) => {
  const reports = BugReporter.listReports();
  res.json({ total: reports.length, reports });
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 Conectado: ${socket.id}`);

  // ── Autenticação ──────────────────────────────────────────────────────────

  socket.on('register', async ({ username, email, password, avatar, bio }) => {
    try {
      if (!username || username.trim().length < 2) {
        return socket.emit('register-error', { message: 'Nome deve ter pelo menos 2 caracteres' });
      }
      const exists = await userDb.findUser({ username: username.trim() });
      if (exists) return socket.emit('register-error', { message: 'Nome de usuário já está em uso' });

      const user = await userDb.createUser({
        username: username.trim(), email, password, avatar: avatar || '😊', bio: bio || ''
      });
      socket.emit('register-success', { user });
      bugReporter.reportInfo('Usuário registrado', { username: user.username });
      console.log(`✅ Registrado: ${user.username}`);
    } catch (err) {
      bugReporter.reportBug('REGISTER_ERROR', err, { username });
      socket.emit('register-error', { message: 'Erro interno ao registrar' });
    }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const user = await userDb.findUser({ username });
      if (!user) return socket.emit('login-error', { message: 'Usuário não encontrado' });

      if (user.password && password) {
        const ok = await userDb.verifyPassword(user.userId, password);
        if (!ok) return socket.emit('login-error', { message: 'Senha incorreta' });
      }

      await _onUserConnected(socket, user);
    } catch (err) {
      bugReporter.reportBug('LOGIN_ERROR', err, { username });
      socket.emit('login-error', { message: 'Erro interno ao fazer login' });
    }
  });

  socket.on('guest-login', async ({ username, avatar }) => {
    try {
      if (!username || username.trim().length < 1) {
        return socket.emit('login-error', { message: 'Digite um nome' });
      }
      // Sufixo curto para evitar colisão
      const suffix = Math.random().toString(36).substring(2, 6);
      const user = await userDb.createUser({
        username: `${username.trim()}#${suffix}`,
        avatar: avatar || '😊',
        bio: 'Usuário convidado'
      });
      await _onUserConnected(socket, user);
    } catch (err) {
      bugReporter.reportBug('GUEST_ERROR', err, { username });
      socket.emit('login-error', { message: 'Erro interno ao entrar como convidado' });
    }
  });

  async function _onUserConnected(socket, user) {
    await userDb.updateUser(user.userId, { status: 'online' });
    onlineUsers.set(user.userId, { socketId: socket.id, username: user.username, status: 'online', voiceChannelId: null });
    socketToUser.set(socket.id, user.userId);

    const groups = await groupDb.getUserGroups(user.userId);
    // Entra nas socket.io rooms dos grupos já existentes
    for (const g of groups) socket.join(`group-${g.groupId}`);

    socket.emit('login-success', { user, groups });
    io.emit('user-status-changed', { userId: user.userId, username: user.username, status: 'online' });
    await broadcastOnlineUsers();
    console.log(`👤 Online: ${user.username}`);
  }

  socket.on('update-profile', async ({ userId, updates }) => {
    try {
      const allowed = ['username', 'avatar', 'bio', 'status'];
      const sanitized = {};
      for (const k of allowed) if (updates[k] !== undefined) sanitized[k] = updates[k];

      await userDb.updateUser(userId, sanitized);
      const user = await userDb.findUser({ userId });
      socket.emit('profile-updated', { user });
      io.emit('user-profile-changed', { userId, username: user.username, avatar: user.avatar });
      if (onlineUsers.has(userId)) onlineUsers.get(userId).status = sanitized.status || onlineUsers.get(userId).status;
    } catch (err) {
      bugReporter.reportBug('UPDATE_PROFILE_ERROR', err, { userId });
      socket.emit('error-msg', { message: 'Erro ao atualizar perfil' });
    }
  });

  // ── Grupos ────────────────────────────────────────────────────────────────

  socket.on('create-group', async ({ name, description, isPrivate, ownerId }) => {
    try {
      if (!name || name.trim().length < 1) {
        return socket.emit('error-msg', { message: 'Nome do grupo inválido' });
      }
      const group = await groupDb.createGroup({ name: name.trim(), description, isPrivate, ownerId });
      socket.join(`group-${group.groupId}`);
      socket.emit('group-created', { group });
      console.log(`🏠 Grupo criado: ${group.name}`);
    } catch (err) {
      bugReporter.reportBug('CREATE_GROUP_ERROR', err, { name });
      socket.emit('error-msg', { message: 'Erro ao criar grupo' });
    }
  });

  // join-group: apenas entra na sala socket, não re-adiciona ao BD
  socket.on('join-group-socket', async ({ groupId }) => {
    socket.join(`group-${groupId}`);
    const userId = socketToUser.get(socket.id);
    if (userId) {
      const group = await groupDb.findGroup(groupId).catch(() => null);
      const user = await userDb.findUser({ userId }).catch(() => null);
      if (group && user) {
        socket.to(`group-${groupId}`).emit('member-online', { groupId, userId, username: user.username, avatar: user.avatar });
      }
    }
  });

  socket.on('join-group-by-id', async ({ groupId, userId }) => {
    try {
      await groupDb.addMember(groupId, userId);
      const group = await groupDb.findGroup(groupId);
      const user = await userDb.findUser({ userId });
      if (!group || !user) return socket.emit('error-msg', { message: 'Grupo ou usuário não encontrado' });

      socket.join(`group-${groupId}`);
      socket.emit('group-joined', { group });
      socket.to(`group-${groupId}`).emit('member-joined', {
        groupId,
        user: { userId: user.userId, username: user.username, avatar: user.avatar }
      });
      console.log(`👥 ${user.username} entrou no grupo ${group.name}`);
    } catch (err) {
      bugReporter.reportBug('JOIN_GROUP_ERROR', err, { groupId });
      socket.emit('error-msg', { message: 'Erro ao entrar no grupo' });
    }
  });

  socket.on('add-channel', async ({ groupId, name, type }) => {
    try {
      const channel = await groupDb.addChannel(groupId, { name: name.trim(), type });
      io.to(`group-${groupId}`).emit('channel-added', { groupId, channel });
    } catch (err) {
      bugReporter.reportBug('ADD_CHANNEL_ERROR', err, { groupId, name });
      socket.emit('error-msg', { message: 'Erro ao criar canal' });
    }
  });

  socket.on('get-group-members', async ({ groupId }) => {
    try {
      const group = await groupDb.findGroup(groupId);
      if (!group) return;
      const members = [];
      for (const uid of group.members) {
        const u = await userDb.findUser({ userId: uid });
        if (u) {
          const online = onlineUsers.get(uid);
          members.push({ ...u, status: online ? online.status : 'offline' });
        }
      }
      socket.emit('group-members-list', { groupId, members });
    } catch (err) {
      bugReporter.reportBug('GET_MEMBERS_ERROR', err, { groupId });
    }
  });

  // ── Mensagens ─────────────────────────────────────────────────────────────

  socket.on('send-message', async ({ groupId, channelId, userId, username, content, avatar }) => {
    try {
      if (!content || !content.trim()) return;
      const message = await messageDb.saveGroupMessage({ groupId, channelId, userId, username, content: content.trim() });
      io.to(`group-${groupId}`).emit('new-message', { ...message, avatar: avatar || '😊' });
    } catch (err) {
      bugReporter.reportBug('SEND_MESSAGE_ERROR', err, { groupId, channelId });
    }
  });

  socket.on('get-messages', async ({ channelId, limit = 50 }) => {
    try {
      const messages = await messageDb.getChannelMessages(channelId, limit);
      socket.emit('messages-loaded', { channelId, messages });
    } catch (err) {
      bugReporter.reportBug('GET_MESSAGES_ERROR', err, { channelId });
    }
  });

  socket.on('send-dm', async ({ from, to, content, fromUsername, fromAvatar }) => {
    try {
      if (!content || !content.trim()) return;
      const message = await messageDb.saveDirectMessage({ from, to, content: content.trim() });
      socket.emit('dm-sent', { message, toUserId: to });
      const recipient = onlineUsers.get(to);
      if (recipient) {
        io.to(recipient.socketId).emit('new-dm', { ...message, fromUsername, fromAvatar: fromAvatar || '😊' });
      }
    } catch (err) {
      bugReporter.reportBug('SEND_DM_ERROR', err, { from, to });
    }
  });

  socket.on('get-dm', async ({ userId1, userId2, limit = 50 }) => {
    try {
      const messages = await messageDb.getDirectMessages(userId1, userId2, limit);
      socket.emit('dm-loaded', { userId2, messages });
    } catch (err) {
      bugReporter.reportBug('GET_DM_ERROR', err, { userId1, userId2 });
    }
  });

  // ── Voz / WebRTC ──────────────────────────────────────────────────────────
  //
  // Fluxo correto:
  //   A entra no canal → servidor avisa B com socketId de A
  //   B cria peer (não-iniciador) e emite 'ready-for-offer' para A
  //   A recebe 'ready-for-offer', cria peer (iniciador) e envia offer para B
  //   B recebe offer, cria answer e envia para A
  //   Troca de ICE candidates ocorre normalmente

  socket.on('join-voice', async ({ channelId, userId, username }) => {
    try {
      // Lista de quem JÁ está no canal antes de entrar
      const roomName = `voice-${channelId}`;
      const existingSockets = await io.in(roomName).fetchSockets();
      const existing = existingSockets
        .filter(s => s.id !== socket.id)
        .map(s => ({ socketId: s.id, userId: socketToUser.get(s.id) || null, username: null }));

      // Busca usernames dos presentes
      for (const e of existing) {
        if (e.userId) {
          const u = await userDb.findUser({ userId: e.userId }).catch(() => null);
          if (u) e.username = u.username;
        }
      }

      socket.join(roomName);
      if (onlineUsers.has(userId)) onlineUsers.get(userId).voiceChannelId = channelId;

      // Informa o novo usuário quem já estava
      socket.emit('voice-existing-users', { users: existing });

      // Informa os presentes que um novo chegou (eles vão enviar ready-for-offer)
      socket.to(roomName).emit('voice-user-joined', { socketId: socket.id, userId, username });

      console.log(`🎤 ${username} entrou no canal de voz ${channelId}`);
    } catch (err) {
      bugReporter.reportBug('JOIN_VOICE_ERROR', err, { channelId, userId });
    }
  });

  socket.on('leave-voice', ({ channelId, userId, username }) => {
    const roomName = `voice-${channelId}`;
    socket.leave(roomName);
    if (onlineUsers.has(userId)) onlineUsers.get(userId).voiceChannelId = null;
    socket.to(roomName).emit('voice-user-left', { socketId: socket.id, userId, username });
    console.log(`🔇 ${username} saiu do canal de voz`);
  });

  // Sinalização WebRTC pura (encaminha para o destino sem modificar)
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Controles de mídia
  socket.on('media-state', ({ channelId, audio, video }) => {
    socket.to(`voice-${channelId}`).emit('peer-media-state', {
      socketId: socket.id,
      audio,
      video
    });
  });

  socket.on('screen-share-start', ({ channelId }) => {
    socket.to(`voice-${channelId}`).emit('peer-screen-share', { socketId: socket.id, active: true });
  });

  socket.on('screen-share-stop', ({ channelId }) => {
    socket.to(`voice-${channelId}`).emit('peer-screen-share', { socketId: socket.id, active: false });
  });

  // ── Amizades ──────────────────────────────────────────────────────────────

  // Envia pedido de amizade por username
  socket.on('friend-request', async ({ fromId, toUsername }) => {
    try {
      const to = await userDb.findUser({ username: toUsername });
      if (!to) return socket.emit('friend-error', { message: 'Usuário não encontrado' });
      if (to.userId === fromId) return socket.emit('friend-error', { message: 'Você não pode se adicionar' });

      await friendDb.sendRequest(fromId, to.userId);
      const from = await userDb.findUser({ userId: fromId });

      socket.emit('friend-request-sent', { to: { userId: to.userId, username: to.username, avatar: to.avatar } });

      // Notifica destinatário se online
      const toOnline = onlineUsers.get(to.userId);
      if (toOnline) {
        io.to(toOnline.socketId).emit('friend-request-received', {
          from: { userId: from.userId, username: from.username, avatar: from.avatar }
        });
      }
      console.log(`👥 ${from.username} enviou pedido para ${to.username}`);
    } catch (err) {
      const msg = err.message === 'Já existe pedido ou amizade'
        ? 'Pedido já enviado ou já são amigos'
        : 'Erro ao enviar pedido';
      socket.emit('friend-error', { message: msg });
    }
  });

  // Aceita pedido
  socket.on('friend-accept', async ({ myId, fromId }) => {
    try {
      await friendDb.accept(fromId, myId);
      const me   = await userDb.findUser({ userId: myId });
      const from = await userDb.findUser({ userId: fromId });

      socket.emit('friend-accepted', { friend: { userId: from.userId, username: from.username, avatar: from.avatar } });

      const fromOnline = onlineUsers.get(fromId);
      if (fromOnline) {
        io.to(fromOnline.socketId).emit('friend-accepted', {
          friend: { userId: me.userId, username: me.username, avatar: me.avatar }
        });
      }
      console.log(`✅ ${me.username} aceitou amizade de ${from.username}`);
    } catch (err) {
      bugReporter.reportBug('FRIEND_ACCEPT_ERROR', err, { myId, fromId });
    }
  });

  // Recusa ou remove amigo
  socket.on('friend-remove', async ({ userId1, userId2 }) => {
    try {
      await friendDb.remove(userId1, userId2);
      socket.emit('friend-removed', { userId: userId2 });
      const other = onlineUsers.get(userId2);
      if (other) io.to(other.socketId).emit('friend-removed', { userId: userId1 });
    } catch (err) {
      bugReporter.reportBug('FRIEND_REMOVE_ERROR', err, { userId1, userId2 });
    }
  });

  // Carrega lista de amigos + pedidos
  socket.on('get-friends', async ({ userId }) => {
    try {
      const [friendships, pending, sent] = await Promise.all([
        friendDb.getFriends(userId),
        friendDb.getPending(userId),
        friendDb.getSent(userId)
      ]);

      // Enriquece com dados do usuário
      const enrich = async (uid) => {
        const u = await userDb.findUser({ userId: uid }).catch(() => null);
        if (!u) return null;
        const online = onlineUsers.get(uid);
        return { ...u, status: online ? online.status : 'offline' };
      };

      const friends = (await Promise.all(
        friendships.map(f => enrich(f.from === userId ? f.to : f.from))
      )).filter(Boolean);

      const pendingIn = (await Promise.all(
        pending.map(f => enrich(f.from))
      )).filter(Boolean);

      const pendingOut = (await Promise.all(
        sent.map(f => enrich(f.to))
      )).filter(Boolean);

      socket.emit('friends-loaded', { friends, pendingIn, pendingOut });
    } catch (err) {
      bugReporter.reportBug('GET_FRIENDS_ERROR', err, { userId });
    }
  });

  // ── Chamada Privada (DM Call) ──────────────────────────────────────────────

  // Iniciar chamada para um usuário
  socket.on('dm-call-offer', ({ fromId, toId, fromUsername, fromAvatar }) => {
    const toOnline = onlineUsers.get(toId);
    if (!toOnline) return socket.emit('dm-call-error', { message: 'Usuário offline' });

    // Cria room temporária para a chamada
    const callRoom = `dmcall-${[fromId, toId].sort().join('-')}`;
    socket.join(callRoom);

    io.to(toOnline.socketId).emit('dm-call-incoming', {
      fromId, fromUsername, fromAvatar, callRoom
    });
    console.log(`📞 ${fromUsername} ligando para ${toId}`);
  });

  // Aceitar chamada
  socket.on('dm-call-accept', ({ callRoom, userId, username }) => {
    socket.join(callRoom);
    socket.to(callRoom).emit('dm-call-accepted', { userId, username });
    console.log(`📞 ${username} aceitou chamada`);
  });

  // Recusar chamada
  socket.on('dm-call-reject', ({ callRoom, username }) => {
    socket.to(callRoom).emit('dm-call-rejected', { username });
    socket.leave(callRoom);
    console.log(`📵 ${username} recusou chamada`);
  });

  // Encerrar chamada
  socket.on('dm-call-end', ({ callRoom, username }) => {
    socket.to(callRoom).emit('dm-call-ended', { username });
    socket.leave(callRoom);
    console.log(`📵 ${username} encerrou chamada`);
  });

  // Sinalização WebRTC para chamada privada (reutiliza evento 'signal')
  // já existe — o callRoom serve como namespace

  // ── Convites de Servidor ──────────────────────────────────────────────────

  // Gera código de convite para um grupo
  socket.on('create-invite', async ({ groupId, userId }) => {
    try {
      const group = await groupDb.findGroup(groupId);
      if (!group) return socket.emit('error-msg', { message: 'Grupo não encontrado' });
      if (!group.members.includes(userId)) return socket.emit('error-msg', { message: 'Você não é membro deste grupo' });

      const invite = await inviteDb.create(groupId, userId);
      socket.emit('invite-created', { code: invite.code, groupName: group.name });
      console.log(`🎟️ Convite criado: ${invite.code} para ${group.name}`);
    } catch (err) {
      bugReporter.reportBug('CREATE_INVITE_ERROR', err, { groupId });
      socket.emit('error-msg', { message: 'Erro ao criar convite' });
    }
  });

  // Usa código de convite para entrar no servidor
  socket.on('use-invite', async ({ code, userId }) => {
    try {
      const invite = await inviteDb.findByCode(code);
      if (!invite) return socket.emit('invite-error', { message: 'Código inválido' });

      const group = await groupDb.findGroup(invite.groupId);
      if (!group) return socket.emit('invite-error', { message: 'Servidor não encontrado' });

      if (group.members.includes(userId)) {
        return socket.emit('invite-error', { message: 'Você já é membro deste servidor' });
      }

      await groupDb.addMember(invite.groupId, userId);
      await inviteDb.use(code);

      const user = await userDb.findUser({ userId });
      socket.join(`group-${group.groupId}`);
      socket.emit('group-joined', { group });
      socket.to(`group-${group.groupId}`).emit('member-joined', {
        groupId: group.groupId,
        user: { userId: user.userId, username: user.username, avatar: user.avatar }
      });
      console.log(`🎟️ ${user.username} entrou em ${group.name} via convite`);
    } catch (err) {
      bugReporter.reportBug('USE_INVITE_ERROR', err, { code });
      socket.emit('invite-error', { message: 'Erro ao usar convite' });
    }
  });

  // Também notifica amigo via DM quando convidado para servidor
  socket.on('invite-friend-to-group', async ({ fromId, toId, groupId }) => {
    try {
      const group = await groupDb.findGroup(groupId);
      const from  = await userDb.findUser({ userId: fromId });
      if (!group || !from) return;

      const invite = await inviteDb.create(groupId, fromId);
      const toOnline = onlineUsers.get(toId);
      if (toOnline) {
        io.to(toOnline.socketId).emit('group-invite-received', {
          fromUsername: from.username,
          fromAvatar:   from.avatar,
          groupName:    group.name,
          code:         invite.code
        });
      }
    } catch (err) {
      bugReporter.reportBug('INVITE_FRIEND_ERROR', err, { fromId, toId, groupId });
    }
  });

  // ── Desconexão ────────────────────────────────────────────────────────────

  socket.on('disconnect', async () => {
    const userId = socketToUser.get(socket.id);
    if (!userId) return;

    socketToUser.delete(socket.id);
    const info = onlineUsers.get(userId);

    // Notifica canal de voz se estava em um
    if (info?.voiceChannelId) {
      socket.to(`voice-${info.voiceChannelId}`).emit('voice-user-left', {
        socketId: socket.id, userId, username: info.username
      });
    }

    onlineUsers.delete(userId);
    await userDb.updateUser(userId, { status: 'offline' }).catch(() => {});
    io.emit('user-status-changed', { userId, status: 'offline' });
    await broadcastOnlineUsers();
    console.log(`❌ Desconectado: ${info?.username || userId}`);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 URL: http://0.0.0.0:${PORT}`);
  console.log(`🐛 Relatórios de bugs: /bugs/latest\n`);
});

process.on('SIGINT', () => {
  bugReporter.getSummary();
  console.log('👋 Servidor encerrado');
  process.exit(0);
});
