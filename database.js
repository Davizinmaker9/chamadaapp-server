const Datastore = require('@seald-io/nedb');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Na nuvem (Railway) usa /data para persistência. Localmente usa server/data
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT
  ? '/data'
  : path.join(__dirname, 'data');

// Garante que a pasta existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Bancos de dados
const db = {
  users:          new Datastore({ filename: path.join(DATA_DIR, 'users.db'),          autoload: true }),
  groups:         new Datastore({ filename: path.join(DATA_DIR, 'groups.db'),         autoload: true }),
  messages:       new Datastore({ filename: path.join(DATA_DIR, 'messages.db'),       autoload: true }),
  directMessages: new Datastore({ filename: path.join(DATA_DIR, 'direct_messages.db'), autoload: true }),
  friendships:    new Datastore({ filename: path.join(DATA_DIR, 'friendships.db'),    autoload: true }),
  invites:        new Datastore({ filename: path.join(DATA_DIR, 'invites.db'),        autoload: true })
};

// Criar índices
db.users.ensureIndex({ fieldName: 'username', unique: true });
// email NÃO tem índice unique porque pode ser null em convidados/sem email
db.groups.ensureIndex({ fieldName: 'groupId', unique: true });

// Funções de usuário
const userDb = {
  // Criar usuário
  createUser: (userData) => {
    return new Promise((resolve, reject) => {
      const user = {
        userId: uuidv4(),
        username: userData.username,
        email: userData.email || null,
        password: userData.password ? bcrypt.hashSync(userData.password, 10) : null,
        avatar: userData.avatar || null,
        status: userData.status || 'online',
        bio: userData.bio || '',
        createdAt: Date.now()
      };

      db.users.insert(user, (err, newUser) => {
        if (err) reject(err);
        else {
          const { password, ...userWithoutPassword } = newUser;
          resolve(userWithoutPassword);
        }
      });
    });
  },

  // Buscar usuário
  findUser: (query) => {
    return new Promise((resolve, reject) => {
      db.users.findOne(query, (err, user) => {
        if (err) reject(err);
        else {
          if (user) {
            const { password, ...userWithoutPassword } = user;
            resolve(userWithoutPassword);
          } else {
            resolve(null);
          }
        }
      });
    });
  },

  // Atualizar usuário
  updateUser: (userId, updates) => {
    return new Promise((resolve, reject) => {
      db.users.update({ userId }, { $set: updates }, {}, (err, numReplaced) => {
        if (err) reject(err);
        else resolve(numReplaced > 0);
      });
    });
  },

  // Listar todos os usuários
  getAllUsers: () => {
    return new Promise((resolve, reject) => {
      db.users.find({}, (err, users) => {
        if (err) reject(err);
        else {
          const usersWithoutPassword = users.map(user => {
            const { password, ...userWithoutPassword } = user;
            return userWithoutPassword;
          });
          resolve(usersWithoutPassword);
        }
      });
    });
  },

  // Verificar senha
  verifyPassword: (userId, password) => {
    return new Promise((resolve, reject) => {
      db.users.findOne({ userId }, (err, user) => {
        if (err) reject(err);
        else if (!user) resolve(false);
        else resolve(bcrypt.compareSync(password, user.password));
      });
    });
  }
};

// Funções de grupo
const groupDb = {
  // Criar grupo
  createGroup: (groupData) => {
    return new Promise((resolve, reject) => {
      const group = {
        groupId: uuidv4(),
        name: groupData.name,
        description: groupData.description || '',
        ownerId: groupData.ownerId,
        members: [groupData.ownerId],
        channels: [
          { channelId: uuidv4(), name: 'geral', type: 'text' },
          { channelId: uuidv4(), name: 'Sala de Voz', type: 'voice' }
        ],
        createdAt: Date.now(),
        isPrivate: groupData.isPrivate || false
      };

      db.groups.insert(group, (err, newGroup) => {
        if (err) reject(err);
        else resolve(newGroup);
      });
    });
  },

  // Buscar grupo
  findGroup: (groupId) => {
    return new Promise((resolve, reject) => {
      db.groups.findOne({ groupId }, (err, group) => {
        if (err) reject(err);
        else resolve(group);
      });
    });
  },

  // Listar grupos do usuário
  getUserGroups: (userId) => {
    return new Promise((resolve, reject) => {
      db.groups.find({ members: userId }, (err, groups) => {
        if (err) reject(err);
        else resolve(groups);
      });
    });
  },

  // Adicionar membro ao grupo
  addMember: (groupId, userId) => {
    return new Promise((resolve, reject) => {
      db.groups.update(
        { groupId },
        { $addToSet: { members: userId } },
        {},
        (err, numReplaced) => {
          if (err) reject(err);
          else resolve(numReplaced > 0);
        }
      );
    });
  },

  // Remover membro do grupo
  removeMember: (groupId, userId) => {
    return new Promise((resolve, reject) => {
      db.groups.update(
        { groupId },
        { $pull: { members: userId } },
        {},
        (err, numReplaced) => {
          if (err) reject(err);
          else resolve(numReplaced > 0);
        }
      );
    });
  },

  // Adicionar canal
  addChannel: (groupId, channelData) => {
    return new Promise((resolve, reject) => {
      const channel = {
        channelId: uuidv4(),
        name: channelData.name,
        type: channelData.type || 'text'
      };

      db.groups.update(
        { groupId },
        { $push: { channels: channel } },
        {},
        (err, numReplaced) => {
          if (err) reject(err);
          else resolve(channel);
        }
      );
    });
  }
};

// Funções de mensagens
const messageDb = {
  // Salvar mensagem de grupo
  saveGroupMessage: (messageData) => {
    return new Promise((resolve, reject) => {
      const message = {
        messageId: uuidv4(),
        groupId: messageData.groupId,
        channelId: messageData.channelId,
        userId: messageData.userId,
        username: messageData.username,
        content: messageData.content,
        timestamp: Date.now()
      };

      db.messages.insert(message, (err, newMessage) => {
        if (err) reject(err);
        else resolve(newMessage);
      });
    });
  },

  // Obter mensagens do canal
  getChannelMessages: (channelId, limit = 50) => {
    return new Promise((resolve, reject) => {
      db.messages
        .find({ channelId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .exec((err, messages) => {
          if (err) reject(err);
          else resolve(messages.reverse());
        });
    });
  },

  // Salvar mensagem direta
  saveDirectMessage: (messageData) => {
    return new Promise((resolve, reject) => {
      const message = {
        messageId: uuidv4(),
        from:      messageData.from,
        to:        messageData.to,
        content:   messageData.content || '',
        file:      messageData.file || null,   // { name, size, type, data } base64
        timestamp: Date.now(),
        read:      false
      };

      db.directMessages.insert(message, (err, newMessage) => {
        if (err) reject(err);
        else resolve(newMessage);
      });
    });
  },

  // Obter mensagens diretas entre dois usuários
  getDirectMessages: (userId1, userId2, limit = 50) => {
    return new Promise((resolve, reject) => {
      db.directMessages
        .find({
          $or: [
            { from: userId1, to: userId2 },
            { from: userId2, to: userId1 }
          ]
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .exec((err, messages) => {
          if (err) reject(err);
          else resolve(messages.reverse());
        });
    });
  },

  // Marcar mensagens como lidas
  markAsRead: (userId) => {
    return new Promise((resolve, reject) => {
      db.directMessages.update(
        { to: userId, read: false },
        { $set: { read: true } },
        { multi: true },
        (err, numReplaced) => {
          if (err) reject(err);
          else resolve(numReplaced);
        }
      );
    });
  }
};

module.exports = {
  db,
  userDb,
  groupDb,
  messageDb,

  // ── Amizades ────────────────────────────────────────────────
  friendDb: {
    // Envia pedido de amizade
    sendRequest: (fromId, toId) => new Promise((resolve, reject) => {
      db.friendships.findOne({
        $or: [{ from: fromId, to: toId }, { from: toId, to: fromId }]
      }, (err, existing) => {
        if (err) return reject(err);
        if (existing) return reject(new Error('Já existe pedido ou amizade'));
        db.friendships.insert(
          { friendshipId: uuidv4(), from: fromId, to: toId, status: 'pending', createdAt: Date.now() },
          (err2, doc) => err2 ? reject(err2) : resolve(doc)
        );
      });
    }),

    // Aceita pedido
    accept: (fromId, toId) => new Promise((resolve, reject) => {
      db.friendships.update(
        { from: fromId, to: toId, status: 'pending' },
        { $set: { status: 'accepted', acceptedAt: Date.now() } },
        {},
        (err, n) => err ? reject(err) : resolve(n > 0)
      );
    }),

    // Recusa / remove
    remove: (userId1, userId2) => new Promise((resolve, reject) => {
      db.friendships.remove(
        { $or: [{ from: userId1, to: userId2 }, { from: userId2, to: userId1 }] },
        { multi: true },
        (err, n) => err ? reject(err) : resolve(n)
      );
    }),

    // Lista amigos aceitos
    getFriends: (userId) => new Promise((resolve, reject) => {
      db.friendships.find(
        { $or: [{ from: userId }, { to: userId }], status: 'accepted' },
        (err, docs) => err ? reject(err) : resolve(docs)
      );
    }),

    // Pedidos pendentes recebidos
    getPending: (userId) => new Promise((resolve, reject) => {
      db.friendships.find({ to: userId, status: 'pending' },
        (err, docs) => err ? reject(err) : resolve(docs)
      );
    }),

    // Pedidos enviados
    getSent: (userId) => new Promise((resolve, reject) => {
      db.friendships.find({ from: userId, status: 'pending' },
        (err, docs) => err ? reject(err) : resolve(docs)
      );
    })
  },

  // ── Convites de servidor ─────────────────────────────────────
  inviteDb: {
    // Cria convite (código único de 8 chars)
    create: (groupId, createdBy) => new Promise((resolve, reject) => {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      db.invites.insert(
        { code, groupId, createdBy, uses: 0, createdAt: Date.now() },
        (err, doc) => err ? reject(err) : resolve(doc)
      );
    }),

    // Busca por código
    findByCode: (code) => new Promise((resolve, reject) => {
      db.invites.findOne({ code: code.toUpperCase() },
        (err, doc) => err ? reject(err) : resolve(doc)
      );
    }),

    // Incrementa uso
    use: (code) => new Promise((resolve, reject) => {
      db.invites.update({ code }, { $inc: { uses: 1 } }, {},
        (err) => err ? reject(err) : resolve()
      );
    })
  }
};
