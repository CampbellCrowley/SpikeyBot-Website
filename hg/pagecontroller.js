// Copyright 2018-2020 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (web@campbellcrowley.com)

(function() {
  console.warn('Page Version: %FILE_MODIFIED_TIMESTAMP%');
  document.getElementById('copyright').innerHTML +=
      '<br><small>Last Modified: %FILE_MODIFIED_TIMESTAMP%</small>';

  const authorizeUrl =
      'https://discordapp.com/api/oauth2/authorize?client_id=4442935347204587' +
      '53&redirect_uri=https%3A%2F%2Fwww.spikeybot.com%2Fredirect&response_ty' +
      'pe=code&scope=identify%20guilds';
  const commands = [
    {cmd: 'createGame', args: ['gid'], name: 'Create/Refresh Game'},
    {
      cmd: 'resetGame',
      args: [
        'gid',
        [
          'Nothing', 'all', 'current', 'events', 'options', 'teams', 'users',
          'npcs', 'stats',
        ],
      ],
      name: 'Reset Data',
    },
    {cmd: 'editTeam', args: ['gid', 'randomize'], name: 'Randomize Teams'},
    {cmd: 'startGame', args: ['gid', 'textChannel'], name: 'Start Game'},
    {cmd: 'nextDay', args: ['gid', 'textChannel'], name: 'Next Day'},
    {cmd: 'gameStep', args: ['gid', 'textChannel'], name: 'Step Game Once'},
    {
      cmd: 'startAutoplay',
      args: ['gid', 'textChannel'],
      name: 'Enable Autoplay',
    },
    {cmd: 'pauseAutoplay', args: ['gid'], name: 'Disable Autoplay'},
    {cmd: 'endGame', args: ['gid'], name: 'End Game'},
  ];

  const weaponMessage = '{attacker} {action} {victim} with {weapon}.';

  const triggerCats = ['game', 'event', 'day'];
  const loginButton = document.getElementById('loginButton');
  const sessionState = document.getElementById('sessionState');
  const mainBody = document.getElementById('mainBody');
  const notSignedIn = document.getElementById('notSignedIn');
  const loadingView = document.getElementById('loadingView');
  const errorView = document.getElementById('errorView');
  const isDev = location.pathname.startsWith('/dev/');
  let currentView = 'login';
  // Random state value to ensure no tampering with requests during OAuth
  // sequence. I believe this is random enough for my purposes.
  const state = (isDev ? 'dev/hg' : 'hg') + Math.random() * 10000000000000000;
  const code = getCookie('code');
  let session = getCookie('session');
  let socket;

  const messageBoxDom = document.getElementById('messageBox');
  const messageBoxWrapperDom = document.getElementById('messageBoxWrapper');

  // Message Box //
  // Queue of messages.
  const messageBoxQueue = [];
  // Timeout for current open message box.
  let messageBoxTimeout;
  // Timeout for closing current message box.
  let messageBoxClearTimeout;
  // Timeout to update the searchable members after all data has been received.
  let updateMemberSearchTimeout;

  let dragging;
  let guildList;
  let guilds = {};
  const channels = {};
  let user = {};
  const members = {};
  const roles = {};
  let statGroups = {};
  const fetchedMembers = {};
  const eventStore = {};
  let eventFetching = {};
  let actions = null;
  let triggers = null;
  let lastAutoCreate = 0;
  let defaultOptions = null;
  let defaultEvents = null;
  let selectedGuild = null;
  let personalEvents = [];
  let lastPersonalEventFetch = 0;
  let loginFailed = false;
  let hashGuild = getHash('guild');
  const fetchingLeaderboard = {};
  let createEventEditing = false;

  // History of reconnection attempts.
  const reconnectHistory = [];
  let reconnecting = false;

  // Used to persist unsaved values across UI updates.
  let createEventValues = {};

  // Stores current arena event data for event the user is creating.
  let cachedArenaEvent = {};

  let unfoldedElements = [];

  // Options to pass to Fuse.js (Fuzzy search).
  const memberSearchOpts = {
    shouldSort: true,
    tokenize: true,
    findAllMatches: true,
    threshold: 0.6,
    location: 0,
    distance: 100,
    maxPatternLength: 32,
    minMatchCharLength: 1,
    keys: [
      'name',
      'user.id',
      'nickname',
      'user.username',
      'user.descriminator',
    ],
  };
  window.Fuse = window.Fuse || null;
  // The current Fuze search object.
  let memberFuse = null;

  // The number of fetchMember requests sent in the last request interval.
  let fetchMemberCount = 0;
  // The Timeout to delay fetchMember requests for.
  let fetchMemberTimeout;
  // Buffered fetchMember requests to send.
  const fetchMemberRequests = [];
  // Number of milliseconds to wait between requests.
  const fetchMemberDelay = 100;
  // Maximum number of members to request at one time.
  const fetchMemberMax = 10;

  /**
   * Cause login flow to start.
   * @public
   */
  window.login = function() {
    setCookie('session', '', 0, isDev ? '/dev/' : undefined);
    setCookie('state', state);
    window.location.href = authorizeUrl + '&state=' + state;
  };
  /**
   * Cause the user to be signed out.
   * @private
   */
  function logout() {
    setCookie('code', '', 0);
    setCookie('session', '', undefined, isDev ? '/dev/' : undefined);
    session = null;
    guilds = {};
    statGroups = {};
    user = {};
    fuse = null;
    memberFuse = null;
    if (guildList) guildList.remove();
    if (socket) {
      socket.emit('logout');
      socket.close();
      socket = null;
    }
    loginButton.innerHTML = '<span>Login</span>';
    loginButton.setAttribute('onclick', 'login()');
    setView('login');
    mainBody.innerHTML = '';
  }

  if (code || session) {
    setView('loading');
    loginButton.innerHTML = '<span>Sign Out</span>';
    loginButton.onclick = logout;
    sessionState.innerHTML = 'Connecting...';
    socket = io(isDev ? 'www.spikeybot.com' : 'kamino.spikeybot.com', {
      path: isDev ? '/socket.io/dev/hg' : '/socket.io/hg',
    });
    socket.on('connect', () => {
      console.log('Socket Connected');
      sessionState.innerHTML = 'Authenticating...';
      if (session) {
        socket.emit('restore', session);
      } else if (code) {
        socket.emit('authorize', code);
      } else {
        sessionState.innerHTML = 'Signed out';
        logout();
      }
    });
    socket.on('authorized', (err, data) => {
      if (err) {
        console.log('Failed to authorize:', err);
        sessionState.innerHTML =
            'Failed to authorize. You may need to sign back in.';
        loginFailed = true;
        logout();
      } else {
        // console.log('Authorized:', data);
        console.log(
            'Authorized:', data.username,
            Object.assign(
                Object.assign({}, data),
                {session: 'REDACTED', sessionId: 'REDACTED'}));
        setCookie('code', '', 0);
        setCookie(
            'session', data.sessionId, data.sessionExpirationDate,
            isDev ? '/dev/' : undefined);
        user = data;
        session = data.sessionId;
        sessionState.innerHTML = '';
        sessionState.appendChild(
            document.createTextNode(data.username + '#' + data.discriminator));
        socket.emit('fetchGuilds');
        if (!defaultOptions) socket.emit('fetchDefaultOptions');
        if (!defaultEvents) socket.emit('fetchDefaultEvents');
        if (!actions || !triggers) socket.emit('fetchActionList');
        fetchPersonalEvents();

        if (getHash('notPatron')) {
          data.isPatron = false;
          console.warn('Forcing Patreon status to false.');
        }

        document.getElementById('patreonButton')
            .classList.toggle('hidden', data.isPatron);
        document.getElementById('patreonThanks')
            .classList.toggle('hidden', !data.isPatron);
      }
    });
    socket.on('disconnect', (reason) => {
      console.log('Socket Disconnect:', reason);
      showMessageBox('Disconnected from server!', 5000, true);
      if (!session) {
        if (!loginFailed) sessionState.innerHTML = 'Disconnected. Signing out.';
        loginFailed = false;
        logout();
      } else {
        sessionState.innerHTML = 'Disconnected. Reconnecting...';
        attemptReconnect();
      }
    });

    socket.on('guilds', handleGuilds);
    socket.on('game', handleGame);
    socket.on('member', handleMember);
    socket.on('memberAdd', handleMemberAdd);
    socket.on('memberRemove', handleMemberRemove);
    socket.on('defaultOptions', function(data) {
      console.log('defaultOptions:', data);
      defaultOptions = data;
    });
    socket.on('defaultEvents', function(data) {
      console.log('defaultEvents:', data);
      defaultEvents = data;
    });
    socket.on('actions', handleActions);
    socket.on('option', handleOption);
    socket.on('channel', handleChannel);
    socket.on('message', handleMessage);
    socket.on('day', handleDay);
    socket.on('dayState', handleDayState);
    socket.on('eventToggled', handleEventToggled);
    socket.on('eventAdded', handleEventAdded);
    socket.on('eventRemoved', handleEventRemoved);
    socket.on('rateLimit', (...args) => {
      if (args[0].group === 'auth' && args[0].level === 1) return;
      console.warn('Rate Limiting:', ...args);
    });

    socket.on('statGroupList', console.log);
    socket.on('statGroupMetadata', console.log);
    socket.on('userStats', console.log);

    socket.on('actionList', (acts, trig) => {
      console.log('Actions', acts);
      console.log('Triggers', trig);
      actions = acts;
      triggers = trig;

      if (selectedGuild) {
        const guild = guilds[selectedGuild];
        const section = document.getElementById('actionSection');
        if (guild && section) makeActionContainer(section, guild);
      }
    });

    // Enable dragging of elements.
    dragging = new HGDragging(socket);
  }

  /**
   * Attempt to reconnect to the server after disconnecting.
   * @private
   */
  function attemptReconnect() {
    if (reconnecting) return;
    reconnecting = true;

    while (reconnectHistory[0] &&
           Date.now() - reconnectHistory[0] > 5 * 60 * 60 * 1000) {
      reconnectHistory.splice(0, 1);
    }

    const num = reconnectHistory.length;
    const delay = num * num * num * 1000;
    console.log(
        'Enqueuing reconnect attempt in', delay, 'ms (Recent attempts: ', num,
        ')');

    setTimeout(() => {
      console.log('Attempting reconnect...');
      reconnecting = false;
      reconnectHistory.push(Date.now());
      socket.open((...args) => {
        console.log(...args);
        if (args[0]) attemptReconnect();
      });
    }, delay);
  }

  /**
   * Handle new guild data from the server.
   * @private
   * @param {?string} err Any error that may have occurred.
   * @param {Object} data Guild data.
   */
  function handleGuilds(err, data) {
    console.log('Guilds:', err, data);
    setView('main');
    if (!err) {
      data = Object.values(data).map((obj) => {
        guilds[obj.id] = obj;
        return obj;
      });
      if (!guildList) guildList = document.createElement('div');
      data.forEach(function(obj) {
        addNewGuild(guildList, obj);
      });
      if (!data || data.length === 0) {
        guildList.innerHTML =
            'Invite SpikeyBot to your server to start managing the Games<br>' +
            '<a class="invite" href="https://www.spikeybot.com/invite/" ' +
            'target="_blank">Invite SpikeyBot</a><br><small>Refresh this page' +
            ' once the bot has joined your server.</small>';
      }
      mainBody.innerHTML = '';
      const title = document.createElement('h2');
      title.innerHTML =
          'Mutual Servers with SpikeyBot <a class="invite" href="https://www' +
          '.spikeybot.com/invite/" target="_blank" id="invite">Invite</a>';
      title.style.marginBottom = 0;
      title.style.marginTop = 0;
      title.style.lineHeight = 0.5;
      const subtitle = document.createElement('a');
      subtitle.innerHTML = '<br>Select a server to manage the Hungry Games';
      subtitle.style.fontWeight = 'normal';
      subtitle.style.fontSize = '0.5em';
      title.appendChild(subtitle);
      if (user.id == '124733888177111041') {
        const gIdInput = document.createElement('input');
        gIdInput.type = 'number';
        gIdInput.oninput = function() {
          socket.emit('fetchGuild', this.value, (err, g) => {
            if (!g) return;
            if (guilds[g.id]) return;
            guilds[g.id] = g;
            addNewGuild(guildList, g);
          });
        };
        title.appendChild(gIdInput);
      }
      mainBody.appendChild(title);
      mainBody.appendChild(guildList);

      if (selectedGuild) selectGuild(selectedGuild);
    }
  }

  /**
   * Add a new guild to the list of all guilds.
   * @private
   * @param {HTMLElement} guildList The parent element to add each guild to.
   * @param {Object} obj The guild object to add.
   */
  function addNewGuild(guildList, obj) {
    const hasPerm = checkPerm(obj, null, 'options') &&
        checkPerm(obj, null, 'events') && checkPerm(obj, null, 'players');
    roles[obj.id] = {};
    const handleClick = function() {
      if (hasPerm) {
        selectedGuild = null;
        setView('loading');
        socket.emit('fetchGames', obj.id, (id, game) => {
          handleGame(obj.id, game);
          selectGuild(obj.id);
          setView('main');
          if (checkPerm(obj, null, 'stats')) {
            fetchStats(obj.id);
          }
        });
        socket.emit('fetchRoles', obj.id, handleRoles);
      } else {
        showMessageBox(
            'You don\'t have permission to view the webview on this server.');
      }
    };
    if (obj.id === hashGuild) handleClick();

    let row = document.getElementById(obj.id);
    if (!row) {
      row = document.createElement('p');
      row.id = obj.id;
      row.classList.add('guildListRow');
      row.onclick = handleClick;
    }
    if (!hasPerm) row.style.cursor = 'not-allowed';

    let sIcon = document.getElementById(`${obj.id}Icon`);
    if (!sIcon) {
      sIcon = document.createElement('img');
      sIcon.id = `${obj.id}Icon`;
      sIcon.setAttribute('decoding', 'async');
      sIcon.classList.add('guildListIcon');
      row.appendChild(sIcon);
    }
    sIcon.src =
        (obj.iconURL ||
         'https://discordapp.com/assets/1c8a54f25d101bdc607cec7228247a9a' +
             '.svg') +
        '?size=128';

    let sName = document.getElementById(`${obj.id}Name`);
    if (!sName) {
      sName = document.createElement('a');
      sName.id = `${obj.id}Name`;
      sName.classList.add('guildListName');
      row.appendChild(sName);
    }
    sName.textContent = obj.name;

    if (user.id == '124733888177111041') {
      let idText = document.getElementById(`${obj.id}DbgId`);
      if (!idText) {
        idText = document.createElement('a');
        idText.id = `${obj.id}DbgId`;
        idText.classList.add('dbggid');
        idText.textContent = obj.id;
        row.appendChild(idText);
      }
    }
    guildList.appendChild(row);
  }
  /**
   * Handle new HG game data from server.
   * @private
   * @param {string|number} guildId The ID of the guild this game is in.
   * @param {SpikeyBot~HungryGames~GuildGame} game The game data.
   */
  function handleGame(guildId, game) {
    console.log('Game:', guildId, game);
    const guild = guilds[guildId];
    const keys = Object.keys(guilds);
    // If user only has one guild, select it by default.
    if (keys.length == 1) {
      selectedGuild = guilds[keys[0]].id;
    } else if (guildId == hashGuild) {
      selectedGuild = guildId;
    }
    if (guild) {
      guild.hg = game;
      if (!members[guild.id]) members[guild.id] = {};
      if (game) {
        if (game.includedNPCs) {
          game.includedUsers =
              game.includedUsers.concat(game.includedNPCs.map((el) => el.id));
          game.includedNPCs.forEach((el) => {
            if (!guild.members.includes(el.id)) guild.members.push(el.id);
            members[guild.id][el.id] = {guild: {id: guild.id}, user: el};
          });
        }
        if (game.excludedNPCs) {
          game.excludedUsers =
              game.excludedUsers.concat(game.excludedNPCs.map((el) => el.id));
          game.excludedNPCs.forEach((el) => {
            if (!guild.members.includes(el.id)) guild.members.push(el.id);
            members[guild.id][el.id] = {guild: {id: guild.id}, user: el};
          });
        }
      }
      console.log('Members', members);
      if (guildId === selectedGuild) {
        selectGuild(selectedGuild);
        if (game) {
          const create = document.getElementById('createGameButton');
          if (create) create.remove();
        }
      }
    }
  }

  /**
   * Handle new actions for a guild.
   * @private
   * @param {string} gId The guild ID the data is for.
   * @param {object} actions The new action data for the guild.
   */
  function handleActions(gId, actions) {
    const guild = guilds[gId];
    if (!guild || !guild.hg) return;
    console.log('Triggers', gId, actions);
    guild.hg.actions = actions;
    if (selectedGuild !== gId) return;

    const section = document.getElementById('actionSection');
    if (section) makeActionContainer(section, guild);
  }
  /**
   * Handle new options received from server.
   * @private
   * @param {string|number} guildId The ID of the guild the option values are
   * for.
   * @param {string} option The option key.
   * @param {*} value The value of the option.
   * @param {*} value2 Second value if object option was changed.
   */
  function handleOption(guildId, option, value, value2) {
    // console.log('Option:', guildId, option, value, value2);
    const guild = guilds[guildId];
    if (guild.hg) {
      if (typeof value === 'string' &&
          typeof guild.hg.options[option] === 'object') {
        guild.hg.options[option][value] = value2;
      } else {
        guild.hg.options[option] = value;
      }
    }
    if (guildId === selectedGuild) {
      const optionRow = document.getElementById(option);
      const row = makeOptionRow(option, guild.hg.options[option]);
      row.style.zIndex = optionRow.style.zIndex;
      optionRow.parentNode.replaceChild(row, optionRow);
    }
  }
  /**
   * Handle new channel data from the server.
   * @private
   * @param {string|number} guildId The ID of the guild this channel is in.
   * @param {string|number} channelId The ID of the channel.
   * @param {Object} channel The stripped down Discord channel data.
   */
  function handleChannel(guildId, channelId, channel) {
    channels[channelId] = channel;
    const doms = document.getElementsByClassName(channelId);
    for (let i = 0; i < doms.length; ++i) {
      if (channel.type === 'text') {
        doms[i].textContent = `＃${channel.name}`;
        const sI = doms[i].parentNode.selectedIndex;
        if (sI >= 0 && doms[i].parentNode.children[sI].disabled) {
          doms[i].parentNode.value = channelId;
        }
      } else if (channel.type === 'category') {
        doms[i].textContent = channel.name;
        doms[i].disabled = true;
        doms[i].style.background = 'darkgrey';
        doms[i].style.fontWeight = 'bolder';
      } else {
        doms[i].textContent = `�${channel.name}`;
        doms[i].disabled = true;
        doms[i].style.background = 'grey';
        doms[i].style.color = '#DDD';
      }
      sortChannelOptions(doms[i].parentNode);
    }
  }
  /**
   * Sort the channels in dropdown select.
   * @private
   * @param {HTMLSelectElement} select The dropdown to sort.
   */
  function sortChannelOptions(select) {
    let sorted = false;
    while (!sorted) {
      sorted = true;
      for (let i = 0; i < select.children.length - 1; i++) {
        const currOpt = select.children[i];
        const nextOpt = select.children[i + 1];
        if (!currOpt.parentNode || !nextOpt.parentNode) continue;
        const currChan = channels[currOpt.value];
        const nextChan = channels[nextOpt.value];
        if (!currChan && nextChan) {
          swapElements(currOpt, nextOpt);
          sorted = false;
          break;
        } else if (!nextChan) {
          continue;
        }

        let currHighPos = currChan.parent;
        if (typeof currHighPos === 'undefined') {
          currHighPos = currChan.position;
        } else {
          currHighPos = currChan.parent.position;
        }
        let nextHighPos = nextChan.parent;
        if (typeof nextHighPos === 'undefined') {
          nextHighPos = nextChan.position;
        } else {
          nextHighPos = nextChan.parent.position;
        }

        if (currHighPos > nextHighPos) {
          swapElements(currOpt, nextOpt);
          sorted = false;
          break;
        } else if (currHighPos == nextHighPos) {
          if (currChan.parent && !nextChan.parent) {
            swapElements(currOpt, nextOpt);
            sorted = false;
            break;
          }
        }
      }
    }
  }

  /**
   * Sort the UI alphabetically for players in a game. Will not sort if more
   * than 150 members.
   * @private
   * @param {HTMLElement} parent The parent element to sort the children of.
   * @param {SpikeyBot~HungryGames~GuildGame} game The game data to match.
   * @param {boolean} [hideExcluded=false] Hide the excluded players from the
   * UI.
   * @param {number} [start=0] The start index of children to sort.
   * @param {boolean} [skipScroll=false] Skip setting up infinite scroll.
   */
  function sortMembers(
      parent, game, hideExcluded = false, start = 0, skipScroll = false) {
    if (!game || !game.currentGame) return;
    const cache = {};
    const list = [].slice.call(parent.children).slice(start);
    if (parent.children.length <= 150) {
      const sorted = list.sort(function(a, b) {
        const idA = a.id;
        const idB = b.id;
        if (!cache[idA]) {
          cache[idA] = findPlayer(idA, game);
          if (hideExcluded) a.classList.toggle('hidden', !cache[idA]);
          if (!cache[idA]) cache[idA] = findMember(idA);
        }
        if (!cache[idB]) {
          cache[idB] = findPlayer(idB, game);
          if (hideExcluded) b.classList.toggle('hidden', !cache[idB]);
          if (!cache[idB]) cache[idB] = findMember(idB);
        }
        if (!cache[idA].name) return 1;
        if (!cache[idB].name) return -1;
        return cache[idA].name.localeCompare(cache[idB].name);
      });
      for (let i = 0; i < sorted.length; i++) {
        parent.appendChild(sorted[i]);
      }
    }
    if (!skipScroll) {
      setTimeout(function() {
        const par = getScrollParent(parent);
        // Ensure we don't double listeners.
        par.removeEventListener('scroll', updateMemberScroll);
        par.addEventListener('scroll', updateMemberScroll);
      });
    }
  }

  /**
   * Handler for when the member list is scrolled. Manages the visibility of
   * player that have not been shown yet.
   * @private
   * @param {Event} event Dom scroll event.
   */
  function updateMemberScroll(event) {
    const prevChild = event.target.lastChild;
    if (!prevChild) return;
    const rect = event.target.getBoundingClientRect();
    const childRect = prevChild.getBoundingClientRect();

    if (childRect.bottom <= rect.top + (rect.height * 1.5)) {
      const guild = guilds[selectedGuild];
      if (!guild) return;
      const next = guild.members.find(function(el) {
        return event.target.getElementsByClassName(el).length == 0;
      });
      if (next) {
        const row = makePlayerRow(members[guild.id][next], guild);
        event.target.appendChild(row);
        dragging.update(selectedGuild);
      }
    }
  }

  /**
   * Find the user in the given game with the given ID.
   * @private
   * @param {string|number} id The user ID to lookup.
   * @param {SpikeyBot~HungryGames~GuildGame} game The game data to search
   * through.
   * @return {?SpikeyBot~HungryGames~Player} The matched player.
   */
  function findPlayer(id, game) {
    return game.currentGame.includedUsers.find((el) => el.id == id);
  }
  /**
   * Find the user with the given ID.
   * @private
   * @param {string|number} id The user ID to lookup.
   * @return {Discord~GuildMember|Object} The matched player, or an empty object
   * with the user's ID as their username and name.
   */
  function findMember(id) {
    const out = (members[selectedGuild] && members[selectedGuild][id]) ||
        {user: {username: id + ''}};
    if (out.user.username === '124733888177111041') {
      out.user.username = 'SpikeyRobot';
    }
    out.name = out.user.username;
    return out;
  }
  /**
   * Sort the UI for players and teams in a game.
   * @private
   * @param {HTMLElement} parent The parent element to sort the children of.
   * @param {SpikeyBot~HungryGames~GuildGame} game The game data to match.
   * @param {boolean} [skipScroll=false] Skip adding scrolling listeners for
   * infinite scroll.
   */
  function sortMembersAndTeams(parent, game, skipScroll = false) {
    // Remove extra teams.
    for (let i = 0; i < parent.children.length; i++) {
      const toDelete = parent.children[i];
      if (!toDelete.classList) continue;
      if (toDelete.id.startsWith('team') &&
          (!game.currentGame.teams || game.options.teamSize === 0 ||
           !game.currentGame.teams.find((t) => `team${t.id}` == toDelete.id))) {
        for (let j in parent.children[i].children) {
          if (j < 1) continue;
          if (!toDelete.children[j].classList) continue;
          parent.insertBefore(
              toDelete.children[j], parent.firstChild.nextSibling);
        }
        toDelete.remove();
        i--;
      }
    }
    if (!game || !game.currentGame.teams || game.options.teamSize === 0) {
      sortMembers(parent, game, true, 0, skipScroll);
    } else {
      const teams = game.currentGame.teams;
      for (let i in teams) {
        if (!teams[i]) continue;
        const tId = `team${teams[i].id}`;
        let teamEl = parent.children.namedItem(tId);
        // Create team.
        if (!teamEl) {
          teamEl = document.createElement('div');
          teamEl.classList.add('playerListTeam');
          teamEl.classList.add('member');
          teamEl.classList.add('droppable');
          teamEl.id = tId;
          const title = document.createElement('input');
          title.value = teams[i].name;
          title.initialValue = title.value;
          title.onchange = teamNameEditHandler;
          title.oninput = function() {
            this.value = this.value.slice(0, 100);
          };
          title.onkeyup = function(event) {
            if (event.keyCode === 13) {
              // Enter
              teamNameEditHandler(event);
            } else if (event.keyCode == 27) {
              // Escape
              this.value = this.initialValue;
              this.blur();
            }
          };
          title.classList.add('playerListTeamName');
          teamEl.appendChild(title);
          parent.appendChild(teamEl);
        } else {
          // Remove extra members from team. Ends before 0 because 0 is title.
          for (let j = teamEl.children.length - 1; j > 0; j--) {
            if (!teamEl.children[j].classList) continue;
            if (!teams[i].players.find((p) => teamEl.children[j].id == p)) {
              teamEl.children[j].classList.add('hidden');
              parent.insertBefore(
                  teamEl.children[j], parent.firstChild.nextSibling);
            }
          }
        }
        sortMembers(teamEl, game, true, 1, skipScroll);
      }
      // Add 'New Team' option
      const teamEl = document.createElement('div');
      teamEl.classList.add('playerListTeam');
      teamEl.classList.add('member');
      teamEl.classList.add('droppable');
      teamEl.id = 'teamNew';
      const title = document.createElement('h3');
      title.appendChild(document.createTextNode('New Team'));
      teamEl.appendChild(title);
      parent.appendChild(teamEl);

      // Add members to teams.
      for (let i = 0; i < parent.children.length; i++) {
        if (!parent.children[i].classList ||
            parent.children[i].id.startsWith('team')) {
          continue;
        }
        const team = teams.find(
            (t) => t.players.find((p) => parent.children[i].id == p));
        if (!team) {
          parent.children[i].classList.add('hidden');
          continue;
        }
        const teamEl = parent.children.namedItem(`team${team.id}`);
        if (!teamEl) {
          console.error(
              'Failed to find appropriate team for player', parent.children[i],
              team);
          continue;
        }
        parent.children[i].classList.remove('hidden');
        teamEl.appendChild(parent.children[i]);
        i--;
      }

      dragging.update(selectedGuild);
    }
  }
  /**
   * Format a player's data into an Element.
   * @private
   * @param {Discord~GuildMember} member The player to format.
   * @param {Object} guild The guild data for the game and player.
   * @param {HTMLDivElement} [row] Element to replace.
   * @return {HTMLDivElement} The element representing the player.
   */
  function makePlayerRow(member, guild, row) {
    if (!row) {
      row = document.createElement('div');
    } else {
      // while (row.children.length) row.lastChild.remove();
    }
    row.classList.add(member.user.id);
    row.id = member.user.id;
    row.classList.add('playerCell');
    row.classList.add('member');
    row.classList.add('draggable');
    row.draggable = true;

    let checkParent = row.getElementsByClassName('checkbox')[0];
    if (!checkParent) {
      checkParent = document.createElement('div');
      checkParent.classList.add('checkbox');
      row.insertBefore(checkParent, row.children[0]);
    }
    let inGames = row.getElementsByTagName('input')[0];
    if (!inGames) {
      inGames = document.createElement('input');
      inGames.type = 'checkbox';
      checkParent.insertBefore(inGames, checkParent.children[0]);
    }
    inGames.disabled = !guild.hg || !guild.hg.currentGame ||
        (member.user.bot && !guild.hg.options.includeBots);
    const isExcluded =
        guild.hg && guild.hg.excludedUsers.find((el) => el === member.user.id);
    const isIncluded = guild.hg &&
        guild.hg.currentGame.includedUsers.find(
            (user) => user.id === member.user.id);
    inGames.checked = !inGames.disabled && !isExcluded;
    if (Boolean(isIncluded) == Boolean(isExcluded || inGames.disabled)) {
      checkParent.style.background = 'red';
      checkParent.title = 'Player will be moved once a new game is created.';
      inGames.title = checkParent.title;
      if ((!guild.hg || !guild.hg.currentGame ||
           !guild.hg.currentGame.inProgress) &&
          Date.now() - lastAutoCreate > 10000) {
        if (checkPerm(guild, null, 'create')) {
          socket.emit('createGame', selectedGuild, (err) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to refresh game.');
            }
          });
        }
        lastAutoCreate = Date.now();
      }
    } else if (inGames.disabled) {
      if (!member.user.bot || !guild.hg || !guild.hg.currentGame) {
        checkParent.title = 'Disabled because there is no game created.';
      } else {
        checkParent.title =
            'Disabled because the "Include Bots" option is false';
      }
      inGames.title = checkParent.title;
      row.title = checkParent.title;
      row.classList.remove('draggable');
      row.draggable = false;
      row.classList.add('notDraggable');
    } else {
      inGames.title = member.user.id;
    }
    inGames.value = member.user.id;
    inGames.onchange = memberCheckBoxHandler;

    let icon = row.getElementsByClassName('iconContainer')[0];
    let newIcon;
    if (member.user.avatarURL) {
      if (icon &&
          member.user.avatarURL.split('?')[0] ===
              icon.children[0].src.split('?')[0]) {
        newIcon = icon;
      } else {
        newIcon = makeAvatarIcon(
            member.user.id, member.user.avatarURL, 32, null, true);
      }
      if (!icon) {
        row.insertBefore(newIcon, checkParent.nextSibling);
      } else {
        row.replaceChild(newIcon, icon);
      }
      icon = newIcon;
    }

    const imgs = row.getElementsByTagName('img');
    for (let i = 0; i < imgs.length; i++) {
      imgs[i].draggable = false;
    }

    let name = row.getElementsByClassName('name')[0];
    if (!name) {
      name = document.createElement('div');
      name.classList.add('name');
      row.insertBefore(name, icon && icon.nextSibling);
    }
    const nickname = member.nickname;
    let username = member.user.username;

    let nameDom = name.getElementsByClassName('nameDom')[0];
    if (!nameDom) {
      nameDom = document.createElement(member.user.isNPC ? 'input' : 'a');
      nameDom.classList.add('nameDom');
      name.appendChild(nameDom);
    } else if (!member.user.isNPC) {
      nameDom.innerHTML = '';
    }

    if (nickname) {
      nameDom.appendChild(document.createTextNode(`(${nickname})`));
      nameDom.appendChild(document.createElement('br'));
    }

    if (!member.user.isNPC) {
      nameDom.appendChild(document.createTextNode(username));
      if (member.user.descriminator) {
        const descrim = document.createElement('a');
        descrim.appendChild(
            document.createTextNode(`#${member.user.descriminator}`));
        descrim.classList.add('descriminator');
        nameDom.appendChild(descrim);
      }
    }
    if (member.color) {
      nameDom.style.color =
          '#' + ('000000' + member.color.toString(16)).slice(-6);
      const color = member.color.toString(16);
      const r = color.substr(0, 2);
      const g = color.substr(2, 2);
      const b = color.substr(4, 2);
      // if (r > 'c8' && g > 'c8' /* &&
      //   b > 'ee' */) {
      //   nameDom.style.background = 'black';
      //   nameDom.style.borderRadius = '10px';
      // }
      if (r < '37' && g < '6a' && b < 'aa') {
        nameDom.style.background = nameDom.style.color;
        nameDom.style.color = '#ddd';
        nameDom.style.borderRadius = '5px';
      }
    }

    if (member.user.bot && !name.getElementsByClassName('botTag')[0]) {
      const botTag = document.createElement('a');
      botTag.classList.add('botTag');
      botTag.innerHTML = 'Bot';
      name.appendChild(botTag);
    } else if (member.user.isNPC) {
      nameDom.value = username;
      nameDom.type = 'text';
      nameDom.classList.add('npcName');
      nameDom.onchange = function() {
        const newName = this.value;
        if (newName === username) return;
        console.log(username, '-->', newName);
        this.disabled = true;
        socket.emit(
            'renameNPC', selectedGuild, member.user.id, newName, (err) => {
              this.disabled = false;
              if (err) {
                console.error(err);
                showMessageBox('Failed to rename NPC');
                this.value = username;
              } else {
                showMessageBox('Changed ' + username + ' to ' + newName);
                member.user.username = newName;
                member.user.name = newName;
                username = newName;
              }
            });
      };
      nameDom.onkeyup = function(event) {
        event.preventDefault();
        console.log(this.value, username, event.keyCode);
        if (event.keyCode === 13) {
          this.onchange();
          this.blur();
        } else if (event.keyCode === 27) {
          this.value = username;
          this.blur();
        }
      };

      let npcTag = name.getElementsByClassName('npcTag')[0];
      if (!npcTag) {
        name.appendChild(document.createElement('br'));
        npcTag = document.createElement('a');
        npcTag.classList.add('botTag');
        npcTag.classList.add('npcTag');
        npcTag.innerHTML = 'NPC';
        name.appendChild(npcTag);

        const npcDelete = document.createElement('span');
        npcDelete.innerHTML = 'Delete';
        npcDelete.classList.add('npcDeleteButton');
        npcDelete.onclick = function() {
          console.log('Removing NPC', member.user.id);
          socket.emit(
              'removeNPC', selectedGuild, member.user.id, function(err) {
                if (err) {
                  console.error(err);
                  return;
                }
                socket.emit('fetchGames', selectedGuild);
              });
        };
        npcTag.appendChild(npcDelete);
      }
    }

    // dragging.add(row);
    return row;
  }
  /**
   * Format an option into it's row.
   * @private
   * @param {string} key The key of the option.
   * @param {*} option The option value.
   * @return {HTMLDivElement} The div representing the option.
   */
  function makeOptionRow(key, option) {
    const row = document.createElement('div');
    row.id = key;
    row.classList.add('member');

    const name = document.createElement('a');
    name.appendChild(document.createTextNode(camelToSpaces(key)));
    name.classList.add('name');
    row.appendChild(name);

    if (!defaultOptions[key]) {
      // console.log(key, 'not in defaultOptions', defaultOptions, option);
      return row;
    }

    if (typeof defaultOptions[key].value === 'boolean') {
      name.outerHTML =
          name.outerHTML.replace(/^<a/, '<label for="' + key + 'Checkbox"')
              .replace(/<\/a>$/, '</label>');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = option;
      checkbox.classList.add('checkbox');
      checkbox.value = key;
      checkbox.id = key + 'Checkbox';
      checkbox.onchange = optionCheckBoxHandler;
      row.appendChild(checkbox);
      makeCheckboxIntoSwitch(checkbox);
    } else if (defaultOptions[key].values) {
      const select = document.createElement('select');
      select.classList.add('input');
      for (let i in defaultOptions[key].values) {
        if (!defaultOptions[key].values[i]) continue;
        const field = document.createElement('option');
        field.value = defaultOptions[key].values[i];
        field.appendChild(
            document.createTextNode(
                camelToSpaces(defaultOptions[key].values[i])));
        select.add(field);
      }
      select.id = key;
      select.value = option;
      select.onchange = optionSelectHandler;
      row.appendChild(select);
    } else if (typeof defaultOptions[key].value === 'object') {
      row.appendChild(document.createElement('br'));

      if (defaultOptions[key].range) {
        const entries = Object.entries(option);
        for (let i = 0; i < entries.length; i++) {
          const label = document.createElement('label');
          label.appendChild(
              document.createTextNode(camelToSpaces(entries[i][0]) + ': '));
          label.classList.add('name');
          row.appendChild(label);
          const input = document.createElement('input');
          input.type = 'number';
          input.classList.add('input');
          input.value = entries[i][1];
          input.name = entries[i][0];
          input.oninput = (function(min, max) {
            return function() {
              if (this.value < min) this.value = min;
              if (this.value > max) this.value = max;
            };
          })(defaultOptions[key].range.min, defaultOptions[key].range.max);
          row.appendChild(input);
        }
      } else {
        const section = makeDeathRateSlider(option);
        section.id = key;
        row.appendChild(section);
      }

      const submit = document.createElement('input');
      submit.type = 'button';
      submit.classList.add('submit');
      submit.value = 'Submit';
      submit.name = key;
      submit.onclick = optionObjectSubmitHandler;

      row.appendChild(submit);

      row.appendChild(document.createElement('br'));
    } else {
      const input = document.createElement('input');
      input.type =
          typeof defaultOptions[key].value === 'string' ? 'text' : 'number';
      input.classList.add('input');
      input.placeholder = option;
      input.value = option;
      input.id = key + 'input';
      input.oninput = function() {
        this.style.fontWeight = this.value == option ? 'normal' : 'bolder';
      };
      const submit = document.createElement('input');
      submit.type = 'button';
      submit.classList.add('submit');
      submit.value = 'Submit';
      submit.name = key;
      submit.onclick = optionSubmitHandler;

      input.onkeyup = function(event) {
        event.preventDefault();
        if (event.keyCode === 13) {
          submit.click();
          this.blur();
        } else if (event.keyCode === 27) {
          this.value = option;
          this.blur();
        }
      };

      row.appendChild(input);
      row.appendChild(submit);
    }

    const def = document.createElement('a');
    def.appendChild(
        document.createTextNode(
            '(Default: ' + JSON.stringify(defaultOptions[key].value) + ')'));
    def.classList.add('default');
    row.appendChild(def);

    const help = document.createElement('span');
    help.classList.add('helpTip');
    const helpIcon = document.createElement('a');
    helpIcon.classList.add('helpIcon');
    helpIcon.innerHTML = '?';
    const helpBubble = document.createElement('span');
    helpBubble.appendChild(
        document.createTextNode(defaultOptions[key].comment));

    help.appendChild(helpIcon);
    help.appendChild(helpBubble);
    row.appendChild(help);

    return row;
  }

  /**
   * Create or update the container showing Action information.
   * @private
   * @param {HTMLElement} container The container to update.
   * @param {Object} guild The guild data to fill the container with.
   */
  function makeActionContainer(container, guild) {
    if (!triggers) {
      container.textContent = 'Unable to load triggers.';
      return;
    }
    let buttonRow = document.getElementById('actionButtonRow');
    if (!buttonRow) {
      buttonRow = document.createElement('div');
      buttonRow.id = 'actionButtonRow';
      container.appendChild(buttonRow);

      const resetActionsButton = document.createElement('button');
      resetActionsButton.style.marginRight = '1em';
      resetActionsButton.style.float = 'right';
      resetActionsButton.textContent = 'Reset All Actions';
      resetActionsButton.onclick = function() {
        socket.emit('resetGame', selectedGuild, 'actions', (err, res) => {
          if (err) {
            console.error(err);
            showMessageBox('Failed to reset actions.');
            return;
          }
          console.log(res);
          showMessageBox(res, 2000);
        });
      };
      buttonRow.appendChild(resetActionsButton);

      const foldActionsButton = document.createElement('button');
      foldActionsButton.textContent = 'Fold All';
      foldActionsButton.onclick = function() {
        const list = document.getElementsByClassName('triggerContainer');
        for (let i = 0; i < list.length; i++) {
          list[i].classList.add('folded');
        }
      };
      buttonRow.appendChild(foldActionsButton);

      const unfoldActionsButton = document.createElement('button');
      unfoldActionsButton.style.marginRight = '1em';
      unfoldActionsButton.textContent = 'Unfold All';
      unfoldActionsButton.onclick = function() {
        const list = document.getElementsByClassName('triggerContainer');
        for (let i = 0; i < list.length; i++) {
          list[i].classList.remove('folded');
        }
      };
      buttonRow.appendChild(unfoldActionsButton);
    }
    const filters = buttonRow.getElementsByClassName('actionButtonOption');
    for (let i = filters.length - 1; i >= 0; i--) {
      let match = false;
      for (const cat of triggerCats) {
        if (filters[i].classList.contains(cat)) {
          match = true;
        }
      }
      if (!match) filters[i].remove();
    }
    for (const cat of triggerCats) {
      const list = buttonRow.getElementsByClassName(cat);
      if (list.length > 0) continue;

      const newOpt = document.createElement('div');
      newOpt.classList.add(cat);
      newOpt.classList.add('actionButtonOption');
      buttonRow.appendChild(newOpt);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = getCookie(`actionCat${cat}`) != 'false';
      checkbox.id = `${cat}ActionButtonOptionCheckbox`;
      checkbox.onchange = function(cat) {
        return function() {
          const list = document.getElementsByClassName('triggerContainer');
          setCookie(
              `actionCat${cat}`, this.checked,
              Date.now() + 365 * 24 * 60 * 60 * 1000);
          for (let i = 0; i < list.length; i++) {
            if (!list[i].classList.contains(cat)) continue;
            list[i].style.display = this.checked ? '' : 'none';
          }
        };
      }(cat);
      checkbox.onchange.apply(checkbox);
      newOpt.appendChild(checkbox);

      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.textContent = camelToSpaces(cat);
      newOpt.appendChild(label);
    }
    const entries = Object.entries(triggers);
    entries.sort((a, b) => b.order - a.order);
    const prev = null;
    for (const t of entries) {
      const el = document.getElementById(`${t[0]}Trigger`);
      container.insertBefore(
          makeTriggerContainer(t[0], t[1], guild, el),
          prev && prev.nextSibling);
    }
  }

  /**
   * Make or update the container showing a trigger and its actions.
   * @private
   * @param {string} name The name of the trigger.
   * @param {object} data Metadata for the trigger.
   * @param {object} guild Guild data this container is for.
   * @param {?HTMLElement} el Element if it exists to update.
   * @return {HTMLElement} The same updated element that was passed, or the
   * created one.
   */
  function makeTriggerContainer(name, data, guild, el) {
    let content;
    if (!el) {
      el = document.createElement('div');
      el.id = `${name}Trigger`;
      el.classList.add('triggerContainer');
      el.classList.add('folded');

      const title = document.createElement('h3');
      title.classList.add('title');
      title.textContent = camelToSpaces(name);
      title.onclick = soloFoldHandler;
      el.appendChild(title);

      content = document.createElement('div');
      content.classList.add('section');
      el.appendChild(content);
    }

    if (!content) content = el.getElementsByClassName('section')[0];

    let types = content.getElementsByClassName('types')[0];
    if (!types) {
      types = document.createElement('p');
      types.classList.add('types');
      content.insertBefore(types, content.children[0]);
    }
    if (data.types) {
      types.textContent =
          `Types: ${data.types.map((el) => camelToSpaces(el)).join(', ')}`;
    } else {
      types.textContent = 'X';
    }

    for (const cat of triggerCats) {
      if (name.startsWith(cat)) {
        el.classList.add(cat);
        const checkbox =
            document.getElementById(`${cat}ActionButtonOptionCheckbox`);
        if (checkbox) el.style.display = checkbox.checked ? '' : 'none';
      }
    }

    let description = content.getElementsByClassName('description')[0];
    if (!description) {
      description = document.createElement('p');
      description.classList.add('description');
      content.insertBefore(description, types.nextSibling);
    }
    const descText = data && data.description || 'Unknown';
    description.textContent = descText;

    const acts =
        guild && guild.hg && guild.hg.actions && guild.hg.actions[name] || [];

    acts.sort((a, b) => a.delay - b.delay);

    const actRows = content.getElementsByClassName('triggerActionRow');

    for (let i = actRows.length - 1; i >= 0; i--) {
      if (!acts.find((el) => el.id === actRows[i].id)) actRows[i].remove();
    }

    for (const a in acts) {
      if (!acts[a]) continue;
      const id = `trigger${acts[a].id}`;
      let actRow = document.getElementById(id);
      if (!actRow) {
        actRow = document.createElement('div');
        actRow.id = id;
        actRow.classList.add('triggerActionRow');
        content.appendChild(actRow);
      }

      let actTitleRow = actRow.getElementsByClassName('titleRow')[0];
      if (!actTitleRow) {
        actTitleRow = document.createElement('div');
        actTitleRow.classList.add('titleRow');
        actRow.appendChild(actTitleRow);
      }

      let actName = actTitleRow.getElementsByClassName('name')[0];
      if (!actName) {
        actName = document.createElement('strong');
        actName.classList.add('name');
        actTitleRow.appendChild(actName);
      }
      actName.textContent = camelToSpaces(acts[a].className || 'ERROR');

      let actType = actTitleRow.getElementsByClassName('type')[0];
      if (!actType) {
        actType = document.createElement('a');
        actType.classList.add('type');
        actTitleRow.appendChild(actType);
      }
      const mainAct =
          actions && actions.find((el) => el.name === acts[a].className) || {};
      const type = (mainAct && mainAct.type) || 'unknown';
      actType.textContent = ` (${camelToSpaces(type)})`;

      let delButton = actTitleRow.getElementsByClassName('delete')[0];
      if (!delButton) {
        delButton = document.createElement('button');
        delButton.textContent = 'X';
        delButton.title = 'Remove Action ' + acts[a].id;
        delButton.onclick = function(act) {
          return function() {
            socket.emit('removeAction', selectedGuild, name, act.id, (err) => {
              if (err) console.error(err);
            });
          };
        }(acts[a]);
        actTitleRow.appendChild(delButton);
      }

      const time = acts[a].delay || 0;
      let preDelay = actRow.getElementsByClassName('preDelay')[0];
      if (!preDelay) {
        preDelay = document.createElement('label');
        preDelay.classList.add('preDelay');
        preDelay.htmlFor = `${id}Delay`;
        preDelay.textContent = 'Delayed ';
        actRow.appendChild(preDelay);
      }

      let delay = actRow.getElementsByClassName('delay')[0];
      if (!delay) {
        delay = document.createElement('input');
        delay.id = preDelay.htmlFor;
        delay.type = 'number';
        delay.classList.add('delay');
        actRow.appendChild(delay);
      }
      if (delay.value !== time / 1000) {
        makeEditable(delay, time / 1000, function(id) {
          return function(value) {
            console.log('Updating action', name, id, 'delay', value * 1000);
            socket.emit(
                'updateAction', selectedGuild, name, id, 'delay', value * 1000,
                (err) => {
                  if (err) {
                    console.error(err);
                    showMessageBox('Failed to update delay.');
                  }
                });
          };
        }(acts[a].id));
      }

      let postDelay = actRow.getElementsByClassName('postDelay')[0];
      if (!postDelay) {
        postDelay = document.createElement('label');
        postDelay.classList.add('postDelay');
        postDelay.htmlFor = preDelay.htmlFor;
        actRow.appendChild(postDelay);
      }
      if (time === 1000) {
        postDelay.textContent = 'second';
      } else {
        postDelay.textContent = 'seconds';
      }

      if (acts[a].data) {
        let argRows = actRow.getElementsByClassName('argRows')[0];
        if (!argRows) {
          argRows = document.createElement('div');
          argRows.classList.add('argRows');
          actRow.appendChild(argRows);
        }
        updateAddAction(
            argRows, name, acts[a].className, false, function(act) {
              return function(key, value) {
                if (act.data[key] === value) return;
                console.log('UpdateAction', name, act.id, key, value);
                socket.emit(
                    'updateAction', selectedGuild, name, act.id, key,
                    value, (err) => {
                      if (err) console.error(err);
                    });
              };
            }(acts[a]));
        const rowList = argRows.getElementsByClassName('arg');
        const action = actions.find((el) => el.name === acts[a].className);
        for (let i = 0; action.args && i < action.args.length; i++) {
          const row = rowList[i];
          row.value = acts[a].data[action.args[i].name];
        }
      }

      let additional = actRow.getElementsByClassName('additional')[0];
      if (!additional) {
        additional = document.createElement('div');
        additional.classList.add('additional');
        actRow.appendChild(additional);
      }
      const elements = Object.entries(acts[a]).filter(
          (el) => !['className', 'delay', 'id', 'data'].includes(el[0]));
      const text = elements.map((el) => {
        if (typeof el[1] === 'object') {
          el[1] = JSON.stringify(el[1], '&nbsp;', 2);
        }
        return el.join(': ');
      });
      additional.textContent = text.join(', ');
    }

    let addAction = el.getElementsByClassName('createTriggerActionRow')[0];
    if (!addAction) {
      addAction = document.createElement('div');
      addAction.classList.add('createTriggerActionRow');
    }
    content.appendChild(addAction);

    let select = addAction.getElementsByClassName('actionList')[0];
    if (!select) {
      select = document.createElement('select');
      select.classList.add('actionList');
      select.style.fontStyle = 'italic';
      select.oninput = function() {
        this.style.fontStyle = this.value.length === 0 ? 'italic' : '';
        updateAddAction(addAction, name, this.value, true);
      };
      addAction.appendChild(select);
    }

    const actList = actions.filter((el) => data.types.includes(el.type));
    const child = Array.prototype.slice.call(select.children);
    for (let i = child.length - 1; i >= 0; i--) {
      if (child[i].value.length > 0 &&
          !actList.find((el) => el.name === child[i].value)) {
        child[i].remove();
      }
    }

    let prev = child.find((el) => el.value.length === 0);
    if (!prev) {
      prev = document.createElement('option');
      prev.value = '';
      prev.textContent = 'Create Action';
      prev.style.fontStyle = 'italic';
      select.appendChild(prev);
    }

    for (const act of actList) {
      if (!act.type) continue;
      let elem = child.find((el) => el.value === act.name);
      if (!elem) {
        elem = document.createElement('option');
        elem.style.fontStyle = 'normal';
        elem.value = act.name;
        elem.textContent = camelToSpaces(act.name);
      }
      select.insertBefore(elem, prev.nextSibling);
      prev = elem;
    }

    return el;
  }
  /**
   * Update the given action row for creating the new action.
   * @private
   * @param {HTMLElement} row The row to update.
   * @param {string} trigger The name of the trigger this action will be for.
   * @param {string} name The name of the action to update the row for.
   * @param {boolean} [showSubmit=false] Show submit button.
   * @param {Function} [handler] Optional handler to fire when value is changed.
   */
  function updateAddAction(row, trigger, name, showSubmit, handler) {
    const action = actions.find((el) => el.name === name);
    const argList = row.getElementsByClassName('arg');
    const args = action && action.args || [];

    for (let i = argList.length - 1; i >= 0; i--) {
      const type = args[i];
      if (!type || !argList[i].classList.contains(type)) argList[i].remove();
    }

    for (let i = 0; i < args.length; i++) {
      const type = args[i];
      if (argList[i] && argList[i].contains(type.type)) continue;
      row.insertBefore(makeActionArgRow(type, handler), argList[i]);
    }

    let submit = row.getElementsByClassName('submit')[0];
    if (!submit && action && showSubmit) {
      submit = document.createElement('button');
      submit.classList.add('submit');
      submit.textContent = 'Create';
      row.appendChild(submit);
    } else if (submit && (!action || !showSubmit)) {
      submit.remove();
    }
    if (submit && action && showSubmit) {
      submit.onclick = function() {
        const collected = {};
        let index = 0;
        for (const child of row.children) {
          if (!child.classList.contains('arg')) continue;
          collected[args[index++].name] = child.value;
        }
        console.log('InsertAction', selectedGuild, trigger, name, collected);
        socket.emit(
            'insertAction', selectedGuild, trigger, name, collected, (err) => {
              if (err) console.error(err);
            });
      };
    }
  }
  /**
   * Make the row for configuring the value of an argument.
   * @private
   * @param {{name: string, type: string}} arg Argument data.
   * @param {Function} [handler] Optional handler to fire on value changed.
   * @return {HTMLElement} The created row.
   */
  function makeActionArgRow(arg, handler) {
    let newArg;
    if (arg.name === 'role') {
      newArg = document.createElement('select');
      newArg.classList.add('arg');

      const roleList = Object.values(roles[selectedGuild]);
      if (!roleList) return;
      roleList.sort((a, b) => b.rawPosition - a.rawPosition);
      for (let j = 0; j < roleList.length; j++) {
        if (roleList[j].name === '@everyone') continue;
        const option = document.createElement('option');
        option.value = roleList[j].id;
        option.textContent = roleList[j].name;

        makeRoleTag(roleList[j], option);
        option.style.margin = '';
        option.style.borderRadius = '';
        option.style.border = '';
        option.style.padding = '';

        newArg.appendChild(option);
        newArg.value = option.value;
      }
    } else if (arg.type === 'text') {
      newArg = document.createElement('input');
      newArg.type = 'text';
      newArg.classList.add('arg');
    } else if (arg.type === 'member') {
      newArg = document.createElement('input');
      newArg.type = 'hidden';
      newArg.classList.add('arg');
      newArg.value = user.id;
    } else {
      newArg = document.createElement('a');
      newArg.textContent = arg.name + ' ' + arg.type;
    }
    if (typeof handler === 'function') {
      newArg.onchange = function() {
        handler(arg.name, this.value);
      };
    }
    return newArg;
  }
  /**
   * Make an element for a user command.
   * @private
   * @param {Object} cmd The command data to send to the server.
   * @param {Object} guild The guild data of the current guild selected.
   * @return {HTMLDivElement} The element representing the command.
   */
  function makeCommandRow(cmd, guild) {
    const row = document.createElement('div');
    row.id = 'command' + cmd.cmd;
    row.classList.add('member');
    row.classList.add('commandRow');

    row.title = cmd.comment || '';

    for (let i in cmd.args) {
      if (cmd.args[i] === 'gid') {
        const id = document.createElement('input');
        id.classList.add('hidden');
        id.type = 'number';
        id.style.width = 0;
        id.value = selectedGuild;
        id.id = `command${cmd.cmd}#${i}`;
        row.appendChild(id);
      } else if (cmd.args[i] === 'textChannel') {
        const select = document.createElement('select');
        select.classList.add('input');
        for (let j in guild.channels) {
          if (!guild.channels[j]) continue;
          const field = document.createElement('option');
          field.value = guild.channels[j].id;
          field.classList.add(guild.channels[j].id);
          if (!channels[guild.channels[j].id]) {
            field.appendChild(document.createTextNode(guild.channels[j].id));
            socket.emit('fetchChannel', guild.id, guild.channels[j].id);
          } else {
            const channel = channels[guild.channels[j].id];
            if (channel.type === 'text') {
              field.appendChild(document.createTextNode(channel.name));
              field.innerHTML = '&#65283;' + field.innerHTML;
            } else if (channel.type === 'category') {
              field.appendChild(document.createTextNode(channel.name));
              field.disabled = true;
              field.style.background = 'darkgrey';
              field.style.fontWeight = 'bolder';
            } else {
              const name = document.createTextNode(channel.name);
              field.appendChild(name);
              field.innerHTML = '&#128266; ' + field.innerHTML;
              field.disabled = true;
              field.style.background = 'grey';
              field.style.color = '#DDD';
            }
          }
          select.add(field);
        }
        sortChannelOptions(select);
        select.id = `command${cmd.cmd}#${i}`;
        if (guild.hg && guild.hg.outputChannel) {
          const defaultIndex = select.selectedIndex;
          select.value = guild.hg.outputChannel;
          if (select.selectedIndex > -1 &&
              select.children[select.selectedIndex].disabled) {
            select.selectedIndex = defaultIndex;
          }
        }
        row.appendChild(select);
      } else if (Array.isArray(cmd.args[i])) {
        const select = document.createElement('select');
        select.classList.add('input');
        for (let j in cmd.args[i]) {
          if (!cmd.args[i][j]) continue;
          const field = document.createElement('option');
          field.value = cmd.args[i][j];
          field.appendChild(document.createTextNode(cmd.args[i][j]));
          select.add(field);
        }
        select.id = `command${cmd.cmd}#${i}`;
        row.appendChild(select);
      } else {
        const textField = document.createElement('input');
        textField.classList.add('hidden');
        textField.type = 'text';
        textField.value = cmd.args[i];
        textField.id = `command${cmd.cmd}#${i}`;
        row.appendChild(textField);
      }
    }
    const submit = document.createElement('input');
    submit.type = 'button';
    submit.classList.add('submit');
    submit.value = cmd.name;
    submit.name = `command${cmd.cmd}`;
    submit.onclick = commandSubmitHandler;
    row.appendChild(submit);

    return row;
  }
  /**
   * Make a new section to contain a type of event.
   * @private
   * @param {HTMLElement} parent The parent container.
   * @param {string} key The type of events this section contains.
   * @param {
   *   SpikeyBot~HungryGames~Event[]
   *   | SpikeyBot~HungryGames~ArenaEvent[]
   *   | SpikeyBot~HungryGames~WeaponEvent[]
   * } events The events to show in this section.
   * @param {category} category The main category of the events used for
   * checking if they are deletable ('default' or 'custom').
   */
  function makeEventSection(parent, key, events, category) {
    let sec = document.getElementById(key + (category || ''));
    if (!sec) {
      sec = document.createElement('div');
      sec.id = key + (category || '');
      sec.classList.add('guildSection');
      sec.classList.add('guildMiniSubSection');
      if (!unfoldedElements.includes(sec.id)) sec.classList.add('folded');
      parent.appendChild(sec);
    }

    const hrName = camelToSpaces(key);

    let title = document.getElementById(sec.id + 'Title');
    if (!title) {
      title = document.createElement('h4');
      title.id = sec.id + 'Title';
      title.classList.add('title');
      title.onclick = foldHandler;
      sec.appendChild(title);
    }
    title.textContent = hrName;

    let container = document.getElementById(sec.id + 'EventSectionContainer');
    if (!container) {
      container = document.createElement('div');
      container.classList.add('section');
      container.classList.add('minisection');
      container.id = sec.id + 'EventSectionContainer';
      sec.appendChild(container);
    }

    selectEventPage(0, container, events, category, key);

    sec.appendChild(container);
  }
  /**
   * Make the container that allows users to choose the type of event they wish
   * to create.
   * @private
   * @param {HTMLElement} container The container to replace with the new data.
   */
  function makeChooseEventContainer(container) {
    container.innerHTML = '';
    container.style.textAlign = 'center';

    const title = document.createElement('h2');
    title.innerHTML = 'Choose event type';
    container.appendChild(title);

    container.appendChild(
        makeEventTypeButton('Bloodbath or Player', function() {
          if (createEventValues) {
            createEventValues = JSON.parse(JSON.stringify(createEventValues));
            createEventValues.id = null;
          }
          makeCreateEventContainer(container, 'normalSingleNew');
        }, 'Normal most common events.'));
    container.appendChild(makeEventTypeButton('Weapon', function() {
      makeCreateWeaponEventContainer(container);
    }, 'Events that contains a weapon from a user\'s inventory.'));
    container.appendChild(
        makeEventTypeButton(
            'Arena',
            function() {
              makeCreateArenaEventContainer(container);
            },
            'The whole arena takes part in an event, and the arena itself ' +
                'will effect players.'));
    container.appendChild(makeEventTypeButton('Personal Events', function() {
      makePersonalEventContainer(container);
    }, 'Select an event that you have created previously.'));
    container.appendChild(makeEventTypeButton('Upload', function() {
      makeUploadEventContainer(container);
    }, 'Upload an event file that was previously downloaded.'));
  }
  /**
   * Make a large button for the event choosing area.
   * @private
   * @param {string} buttonText The text to put on the button.
   * @param {function} clickCB The event handler for the `onclick` event.
   * @param {string} descriptionText The text to show under the button
   * describing this choice.
   * @return {HTMLDivElement} Element containing the button and description.
   */
  function makeEventTypeButton(buttonText, clickCB, descriptionText) {
    const container = document.createElement('div');
    container.classList.add('eventTypeParent');
    const button = document.createElement('button');
    button.innerHTML = buttonText;
    button.onclick = clickCB;
    container.appendChild(button);
    const description = document.createElement('a');
    description.innerHTML = descriptionText;
    container.appendChild(description);
    return container;
  }
  /**
   * Make the container that shows the inputs required to create an event.
   * @private
   * @param {HTMLElement} container The element to replace.
   * @param {string} id This container's ID.
   * @param {function} [overrideCB] The function to override the create event
   * callback. Using this allows embedding the container in another event type.
   * @param {boolean} [isWeapon=false] Is this event container for a weapon type
   * event.
   */
  function makeCreateEventContainer(
      container, id, overrideCB, isWeapon = false) {
    container.innerHTML = '';
    container.style.textAlign = 'left';

    if (!overrideCB) {
      const backButton = document.createElement('button');
      backButton.classList.add('eventBackButton');
      backButton.innerHTML = 'Back';
      backButton.onclick = function() {
        makeChooseEventContainer(container);
      };
      container.appendChild(backButton);

      const title = document.createElement('h2');
      title.innerHTML = 'Player or Bloodbath Event';
      title.style.textAlign = 'center';
      container.appendChild(title);

      const typeInput = document.createElement('select');
      typeInput.id = 'createEventType' + id;
      typeInput.style.width = '9%';
      container.appendChild(typeInput);
      if (!createEventValues.id) {
        const opt1 = document.createElement('option');
        opt1.value = 'bloodbath';
        opt1.innerHTML = 'Bloodbath';
        typeInput.add(opt1);
        const opt2 = document.createElement('option');
        opt2.value = 'player';
        opt2.innerHTML = 'Player';
        typeInput.add(opt2);
        typeInput.value = 'player';
      }

      if (createEventValues && createEventValues.cat &&
          ['player', 'bloodbath'].includes(createEventValues.cat)) {
        typeInput.value = createEventValues.cat;
      }
    }

    const messageInput = document.createElement('input');
    messageInput.id = 'createEventMessage' + id;
    messageInput.type = 'text';
    messageInput.style.width = overrideCB ? '100%' : '90%';
    messageInput.style.textAlign = 'left';
    messageInput.placeholder = 'Event Message';
    messageInput.oninput = function() {
      updateEventPreview(id);
    };
    container.appendChild(messageInput);

    const helpRow = document.createElement('div');
    container.appendChild(helpRow);

    const help = document.createElement('a');
    help.textContent = 'Tag Info';
    help.classList.add('tagInfoLink');
    helpRow.appendChild(help);
    help.onclick = function() {
      helpRow.innerHTML = '';
      helpRow.classList.add('tagInfoList');

      const victim = document.createElement('a');
      victim.innerHTML =
          '<strong>{victim}</strong> will be replaced with the names of the v' +
          'ictims.<br>';
      victim.onclick = function() {
        messageInput.value = messageInput.value + '{victim}';
        updateEventPreview.call(messageInput, id);
      };
      helpRow.appendChild(victim);

      const attacker = document.createElement('a');
      attacker.innerHTML =
          '<strong>{attacker}</strong> will be replaced with the names of the' +
          ' attackers.<br>';
      attacker.onclick = function() {
        messageInput.value = messageInput.value + '{attacker}';
        updateEventPreview.call(messageInput, id);
      };
      helpRow.appendChild(attacker);

      const dead = document.createElement('a');
      dead.innerHTML =
          '<strong>{dead}</strong> will be replaced with the name of a dead ' +
          'player, or "an animal" if nobody is dead.<br>';
      dead.onclick = function() {
        messageInput.value = messageInput.value + '{dead}';
        updateEventPreview.call(messageInput, id);
      };
      helpRow.appendChild(dead);

      const vSwitch = document.createElement('a');
      vSwitch.innerHTML =
          '<strong>[Vsingular|plural]</strong> will only show the word ' +
          '"singular" if there is one victim, and "plural" otherwise.<br>';
      vSwitch.onclick = function() {
        messageInput.value = messageInput.value + '[Vsingular|plural]';
        updateEventPreview.call(messageInput, id);
      };
      helpRow.appendChild(vSwitch);

      const aSwitch = document.createElement('a');
      aSwitch.innerHTML =
          '<strong>[Asingular|plural]</strong> does the same but for ' +
          'attackers.';
      aSwitch.onclick = function() {
        messageInput.value = messageInput.value + '[Asingular|plural]';
        updateEventPreview.call(messageInput, id);
      };
      helpRow.appendChild(aSwitch);

      if (isWeapon) {
        const owner = document.createElement('a');
        owner.innerHTML =
            '<br><br><strong>{owner}</strong> is replaced with the name of th' +
            'e person who possesses the weapon with <strong>\'s</strong>, or ' +
            '"their" if the attacker is not the same person.';
        owner.onclick = function() {
          messageInput.value = messageInput.value + '{owner}';
          updateEventPreview.call(messageInput, id);
        };
        helpRow.appendChild(owner);
      }
    };

    const line1 = document.createElement('div');
    line1.classList.add('thinline');
    container.appendChild(line1);

    const numVLabel = document.createElement('label');
    numVLabel.innerHTML = 'Number of Victims:';
    container.appendChild(numVLabel);
    const numV = document.createElement('input');
    numV.id = 'createEventNumVictim' + id;
    numVLabel.htmlFor = numV.id;
    numV.type = 'number';
    numV.style.width = '3em';
    numV.oninput = function() {
      updateEventPreview(id);
    };
    container.appendChild(numV);

    const numALabel = document.createElement('label');
    numALabel.innerHTML = 'Attackers:';
    container.appendChild(numALabel);
    const numA = document.createElement('input');
    numA.id = 'createEventNumAttacker' + id;
    numALabel.htmlFor = numA.id;
    numA.type = 'number';
    numA.style.width = '3em';
    numA.oninput = function() {
      updateEventPreview(id);
    };
    container.appendChild(numA);

    const tip = document.createElement('small');
    tip.innerHTML = '(Negative numbers mean "At least" the value)';
    container.appendChild(tip);

    const linebreak = document.createElement('br');
    container.appendChild(linebreak);

    const vOutcomeLabel = document.createElement('label');
    vOutcomeLabel.innerHTML = 'Outcome of Victims:';
    container.appendChild(vOutcomeLabel);

    const victimOutcome = document.createElement('select');
    victimOutcome.id = 'createEventVictimOutcome' + id;
    vOutcomeLabel.htmlFor = victimOutcome.id;
    victimOutcome.onchange = function() {
      updateEventPreview(id);
    };
    const victimNothing = document.createElement('option');
    victimNothing.value = 'nothing';
    victimNothing.innerHTML = 'Nothing';
    victimOutcome.appendChild(victimNothing);
    const victimDies = document.createElement('option');
    victimDies.value = 'dies';
    victimDies.innerHTML = 'Dies';
    victimOutcome.appendChild(victimDies);
    const victimThrives = document.createElement('option');
    victimThrives.value = 'thrives';
    victimThrives.innerHTML = 'Healed';
    victimOutcome.appendChild(victimThrives);
    const victimRevived = document.createElement('option');
    victimRevived.value = 'revived';
    victimRevived.innerHTML = 'Revived';
    victimOutcome.appendChild(victimRevived);
    const victimWounded = document.createElement('option');
    victimWounded.value = 'wounded';
    victimWounded.innerHTML = 'Wounded';
    victimOutcome.appendChild(victimWounded);
    container.appendChild(victimOutcome);

    const aOutcomeLabel = document.createElement('label');
    aOutcomeLabel.innerHTML = ' Attackers:';
    container.appendChild(aOutcomeLabel);

    const attackerOutcome = document.createElement('select');
    attackerOutcome.id = 'createEventAttackerOutcome' + id;
    aOutcomeLabel.htmlFor = attackerOutcome.id;
    attackerOutcome.onchange = function() {
      updateEventPreview(id);
    };
    const attackerNothing = document.createElement('option');
    attackerNothing.value = 'nothing';
    attackerNothing.innerHTML = 'Nothing';
    attackerOutcome.appendChild(attackerNothing);
    const attackerDies = document.createElement('option');
    attackerDies.value = 'dies';
    attackerDies.innerHTML = 'Dies';
    attackerOutcome.appendChild(attackerDies);
    const attackerThrives = document.createElement('option');
    attackerThrives.value = 'thrives';
    attackerThrives.innerHTML = 'Healed';
    attackerOutcome.appendChild(attackerThrives);
    const attackerRevived = document.createElement('option');
    attackerRevived.value = 'revived';
    attackerRevived.innerHTML = 'Revived';
    attackerOutcome.appendChild(attackerRevived);
    const attackerWounded = document.createElement('option');
    attackerWounded.value = 'wounded';
    attackerWounded.innerHTML = 'Wounded';
    attackerOutcome.appendChild(attackerWounded);
    container.appendChild(attackerOutcome);

    const line2 = document.createElement('div');
    line2.classList.add('thinline');
    container.appendChild(line2);

    const vKLabel = document.createElement('label');
    vKLabel.innerHTML = 'Victims kill anyone in this event?';
    container.appendChild(vKLabel);
    const victimKiller = document.createElement('input');
    victimKiller.type = 'checkbox';
    victimKiller.id = 'createEventVictimKiller' + id;
    vKLabel.htmlFor = victimKiller.id;
    container.appendChild(victimKiller);

    const aKLabel = document.createElement('label');
    aKLabel.innerHTML = 'Attackers?';
    container.appendChild(aKLabel);
    const attackerKiller = document.createElement('input');
    attackerKiller.type = 'checkbox';
    attackerKiller.id = 'createEventAttackerKiller' + id;
    aKLabel.htmlFor = attackerKiller.id;
    container.appendChild(attackerKiller);

    const kInfo = document.createElement('small');
    kInfo.innerHTML =
        '<br>This is used for tracking the number of kills a player ' +
        'gets in a game.';
    container.appendChild(kInfo);

    const line3 = document.createElement('div');
    line3.classList.add('thinline');
    container.appendChild(line3);

    const guild = guilds[selectedGuild];
    const weaponSelectContainer = document.createElement('div');
    weaponSelectContainer.innerHTML = 'Victims gain weapon: ';
    const vWeaponSelect = document.createElement('select');
    vWeaponSelect.id = 'createEventVictimWeaponSelect' + id;
    vWeaponSelect.onchange = function() {
      updateEventPreview(id);
    };
    const vWeaponDefaultOption = document.createElement('option');
    vWeaponDefaultOption.value = '';
    vWeaponDefaultOption.innerHTML = 'None';
    vWeaponDefaultOption.style.color = 'gray';
    vWeaponDefaultOption.style.fontStyle = 'italic';
    vWeaponSelect.appendChild(vWeaponDefaultOption);
    const weaponList = defaultEvents.weapon;
    if (guild.hg && guild.hg.customEventStore &&
        guild.hg.customEventStore.weapon) {
      for (const w of guild.hg.customEventStore.weapon) {
        if (!weaponList.includes(w)) weaponList.push(w);
      }
    }
    for (const w of weaponList) {
      const newOpt = document.createElement('option');
      newOpt.value = w;
      const evt = getEvent(w);
      newOpt.textContent = evt && evt.name || w;
      vWeaponSelect.appendChild(newOpt);
    }
    weaponSelectContainer.appendChild(vWeaponSelect);
    const vWeaponQuantity = document.createElement('input');
    vWeaponQuantity.id = 'createEventVictimWeaponQuantity' + id;
    vWeaponQuantity.type = 'number';
    vWeaponQuantity.value = 0;
    vWeaponQuantity.placeholder = 0;
    vWeaponQuantity.style.width = '3em';
    vWeaponQuantity.oninput = function() {
      if (this.value < 0) this.value = 0;
      updateEventPreview(id);
    };
    weaponSelectContainer.appendChild(vWeaponQuantity);

    let evt = createEventValues && createEventValues.victim &&
        createEventValues.victim.weapon && createEventValues.victim.weapon.id &&
        getEvent(createEventValues.victim.weapon.id);

    if (evt) {
      vWeaponSelect.value = evt.name;
      vWeaponQuantity.value = createEventValues.victim.weapon.count;
    }

    weaponSelectContainer.appendChild(document.createElement('br'));
    weaponSelectContainer.appendChild(
        document.createTextNode('Attackers gain weapon: '));

    const aWeaponSelect = document.createElement('select');
    aWeaponSelect.id = 'createEventAttackerWeaponSelect' + id;
    aWeaponSelect.onchange = function() {
      updateEventPreview(id);
    };
    const aWeaponDefaultOption = document.createElement('option');
    aWeaponDefaultOption.value = '';
    aWeaponDefaultOption.innerHTML = 'None';
    aWeaponDefaultOption.style.color = 'gray';
    aWeaponDefaultOption.style.fontStyle = 'italic';
    aWeaponSelect.appendChild(aWeaponDefaultOption);
    for (const w of weaponList) {
      const newOpt = document.createElement('option');
      newOpt.value = w;
      const evt = getEvent(w);
      newOpt.textContent = evt && evt.name || w;
      aWeaponSelect.appendChild(newOpt);
    }
    weaponSelectContainer.appendChild(aWeaponSelect);
    const aWeaponQuantity = document.createElement('input');
    aWeaponQuantity.id = 'createEventAttackerWeaponQuantity' + id;
    aWeaponQuantity.type = 'number';
    aWeaponQuantity.value = 0;
    aWeaponQuantity.placeholder = 0;
    aWeaponQuantity.style.width = '3em';
    aWeaponQuantity.oninput = function() {
      if (this.value < 0) this.value = 0;
      updateEventPreview(id);
    };
    weaponSelectContainer.appendChild(aWeaponQuantity);
    container.appendChild(weaponSelectContainer);

    evt = createEventValues && createEventValues.attacker &&
        createEventValues.attacker.weapon &&
        createEventValues.attacker.weapon.id &&
        getEvent(createEventValues.attacker.weapon.id);
    if (evt) {
      aWeaponSelect.value = evt.name;
      aWeaponQuantity.value = createEventValues.attacker.weapon.count;
    }

    if (isWeapon) {
      const line4 = document.createElement('div');
      line4.classList.add('thinline');
      container.appendChild(line4);

      const weaponConsumeParent = document.createElement('div');
      const weaponConsumeText = document.createElement('a');
      weaponConsumeText.innerHTML =
          'The number of weapon consumables this event uses: ';
      weaponConsumeParent.appendChild(weaponConsumeText);
      const weaponConsumeInput = document.createElement('input');
      weaponConsumeInput.id = 'createEventWeaponConsumed' + id;
      weaponConsumeInput.type = 'text';
      weaponConsumeInput.value = 0;
      weaponConsumeInput.oninput = function() {
        if (this.value < 0) this.value = 0;
        updateEventPreview(id);
      };
      if (createEventValues && createEventValues.consumes) {
        weaponConsumeInput.value = createEventValues.consumes;
      }
      weaponConsumeParent.appendChild(weaponConsumeInput);
      const weaponConsumeHelp = document.createElement('small');
      weaponConsumeHelp.innerHTML =
          '<br>(Use "V" or "A" to consume one item for each victim or ' +
          'attacker)';
      weaponConsumeParent.appendChild(weaponConsumeHelp);
      container.appendChild(weaponConsumeParent);
    }

    const line5 = document.createElement('div');
    line5.classList.add('thinline');
    container.appendChild(line5);

    const preview = document.createElement('div');
    preview.id = 'createEventPreview' + id;
    container.appendChild(preview);

    const submit = document.createElement('button');
    submit.innerHTML = 'Submit';
    submit.onclick = function() {
      checksPassed = 0;
      confirmSingleEvent();
    };
    container.appendChild(submit);
    let checksPassed = 0;
    /**
     * Check that all values are allowed, and that the user has intended, then
     * submit.
     */
    function confirmSingleEvent() {
      const type = (document.getElementById('createEventType' + id) || {
        value: 'unknown',
      }).value;
      const message = document.getElementById('createEventMessage' + id).value;
      const nV = document.getElementById('createEventNumVictim' + id).value;
      const nA = document.getElementById('createEventNumAttacker' + id).value;

      /**
       * Create handler for when user confirms the event creation.
       * @private
       * @return {function} Handler to fire when event should be sent to the
       * server.
       */
      function confirmEventCreation() {
        const type_ = type;
        const message_ = message;
        const nV_ = nV;
        const nA_ = nA;
        const oV =
            document.getElementById('createEventVictimOutcome' + id).value;
        const oA =
            document.getElementById('createEventAttackerOutcome' + id).value;
        const kV =
            document.getElementById('createEventVictimKiller' + id).checked;
        const kA =
            document.getElementById('createEventAttackerKiller' + id).checked;
        const vWCount =
            document.getElementById('createEventVictimWeaponQuantity' + id)
                .value;
        const aWCount =
            document.getElementById('createEventAttackerWeaponQuantity' + id)
                .value;
        const vWName =
            document.getElementById('createEventVictimWeaponSelect' + id).value;
        const aWName =
            document.getElementById('createEventAttackerWeaponSelect' + id)
                .value;
        let wV;
        let wA;

        if (vWCount < 1 || !vWName) {
          wV = null;
        } else {
          wV = {id: vWName, count: vWCount};
        }
        if (aWCount < 1 || !aWName) {
          wA = null;
        } else {
          wA = {id: aWName, count: aWCount};
        }
        let consumes = null;
        const consumeInput =
            document.getElementById('createEventWeaponConsumed' + id);
        if (consumeInput) {
          consumes = consumeInput.value;
          if (!(consumes + '').match(/^(\d*)(V|A)?$/)) {
            showMessageBox(
                'The amount of consumables is not a valid value. ' +
                'A number or "A" or "V" is allowed.');
            return;
          }
        }

        if (overrideCB) {
          return function() {
            createEventEditing = false;
            const evt = {
              type: 'normal',
              message: message_,
              victim: {count: nV_, outcome: oV, killer: kV, weapon: wV},
              attacker: {count: nA_, outcome: oA, killer: kA, weapon: wA},
              consumes: consumes || 0,
            };
            if (createEventValues.id) evt.id = createEventValues.id;
            overrideCB(type_, evt);
          };
        } else {
          return function() {
            createEventEditing = false;
            const evt = {
              type: 'normal',
              message: message_,
              victim: {count: nV_, outcome: oV, killer: kV, weapon: wV},
              attacker: {count: nA_, outcome: oA, killer: kA, weapon: wA},
            };
            if (createEventValues.id) {
              evt.id = createEventValues.id;
              socket.emit('replaceEvent', evt, (err) => {
                if (err) {
                  console.error(err);
                  showMessageBox('Failed to edit event.');
                  return;
                }
                createEventValues = {};
                makeChooseEventContainer(container);
              });
            } else {
              socket.emit('createEvent', evt, (err, eId) => {
                if (err) {
                  console.error(err, eId);
                  showMessageBox('Failed to create event.');
                  return;
                }
                console.log('Created event:', eId, evt);
                createEventValues = {};
                makeChooseEventContainer(container);
                socket.emit('addEvent', selectedGuild, type_, eId, (...err) => {
                  if (err && err.length > 0 && err[0]) {
                    console.error(...err);
                    showMessageBox(
                        'Created event, but failed to add it to server.');
                    return;
                  }
                  console.log(
                      'Added event to server:', selectedGuild, eId, type_, evt);
                  showMessageBox('Event created and added to server.');
                });
              });
            }
          };
        }
      }

      const hasVictim = message.indexOf('{victim}') >= 0;
      const hasAttacker = message.indexOf('{attacker}') >= 0;
      if (!message || message.length <= 0) {
        showMessageBox('Failed to create event. Event must have a message.');
      } else if (
        !(checksPassed & (1 << 1)) && !hasVictim && nV != 0 && !hasAttacker &&
          nA != 0) {
        showYesNoBox(
            'There are no any tags for neither victims nor attackers in the ' +
                'message ({victim} or {attacker}), but the number of victims ' +
                'and attackers is not 0.<br><br>Are you sure you wish to do ' +
                'this?',
            function() {
              checksPassed |= 1 << 1;
              confirmSingleEvent();
            },
            null);
      } else if (hasVictim && nV == 0) {
        showMessageBox(
            'There is a tag for victim in the message, but the number of ' +
            'victims is set to 0.\n\nPlease ensure the number of victims is ' +
            'not 0.');
      } else if (!(checksPassed & (1 << 2)) && !hasVictim && nV != 0) {
        showYesNoBox(
            'There are no tags for victims in the message, but the number of ' +
                'victims is not 0.<br><br>Are you sure you wish to do this?',
            function() {
              checksPassed |= 1 << 2;
              confirmSingleEvent();
            },
            null);
      } else if (hasAttacker && nA == 0) {
        showMessageBox(
            'There is a tag for attacker in the message, but the number of at' +
            'tackers is set to 0.\n\nPlease ensure the number of attackers is' +
            ' not 0.');
      } else if (!(checksPassed & (1 << 3)) && !hasAttacker && nA != 0) {
        showYesNoBox(
            'There are no tags for attackers in the message, but the number ' +
                'of attackers is not 0.<br><br>Are you sure you wish to do ' +
                'this?',
            function() {
              checksPassed |= 1 << 3;
              confirmSingleEvent();
            },
            null);
      } else {
        confirmEventCreation()();
      }
    }

    messageInput.value = createEventValues.message || '';
    if (createEventValues.victim) {
      numV.value = createEventValues.victim.count || 0;
      victimOutcome.value = createEventValues.victim.outcome || 'nothing';
      victimKiller.checked = createEventValues.victim.killer || false;
      if (createEventValues.victim.weapon) {
        vWeaponSelect.value = createEventValues.victim.weapon.id || '';
        vWeaponQuantity.value = createEventValues.victim.weapon.count || 1;
      }
    } else {
      numV.value = 0;
    }
    if (createEventValues.attacker) {
      numA.value = createEventValues.attacker.count || 0;
      attackerOutcome.value = createEventValues.attacker.outcome || 'nothing';
      attackerKiller.checked = createEventValues.attacker.killer || false;
      if (createEventValues.attacker.weapon) {
        aWeaponSelect.value = createEventValues.attacker.weapon.id || '';
        aWeaponQuantity.value = createEventValues.attacker.weapon.count || 1;
      }
    } else {
      numA.value = 0;
    }
  }
  /**
   * Creates the container for creating a weapon event.
   * @private
   * @param {HTMLElement} container The container to replace.
   */
  function makeCreateWeaponEventContainer(container) {
    container.innerHTML = '';
    container.style.textAlign = 'left';

    const backButton = document.createElement('button');
    backButton.classList.add('eventBackButton');
    backButton.innerHTML = 'Back';
    backButton.onclick = function() {
      makeChooseEventContainer(container);
    };
    container.appendChild(backButton);

    const title = document.createElement('h2');
    title.innerHTML = 'Weapon';
    title.style.textAlign = 'center';
    title.style.background = 'transparent';
    container.appendChild(title);

    const guild = guilds[selectedGuild];

    if (!cachedArenaEvent) {
      cachedArenaEvent = {};
    }
    const eventWeaponName = document.createElement('input');
    eventWeaponName.id = 'eventStartMessageInput';
    eventWeaponName.type = 'text';
    eventWeaponName.placeholder = 'Weapon name';
    eventWeaponName.oninput = function() {
      cachedArenaEvent.name = this.value;
    };
    if (cachedArenaEvent.name) {
      eventWeaponName.value = cachedArenaEvent.name;
    }
    container.appendChild(eventWeaponName);

    const eventConsumableName = document.createElement('input');
    eventConsumableName.id = 'eventConsumableNameInput';
    eventConsumableName.type = 'text';
    eventConsumableName.placeholder = 'Consumable name (or blank for none)';
    eventConsumableName.oninput = function() {
      cachedArenaEvent.consumable = this.value;
    };
    if (cachedArenaEvent.consumable) {
      eventConsumableName.value = cachedArenaEvent.consumable;
    }
    container.appendChild(eventConsumableName);

    const consumableNameInfo = document.createElement('small');
    consumableNameInfo.style.width = '90%';
    consumableNameInfo.style.marginLeft = '5%';
    consumableNameInfo.innerHTML =
        'Consumable and weapon can have "[Csingular|plural]" style tags to' +
        ' show "singular" when one weapon/consumable is used, or "plural" ' +
        'otherwise.';
    container.appendChild(consumableNameInfo);

    if (cachedArenaEvent && cachedArenaEvent.outcomes) {
      for (let i = 0; i < cachedArenaEvent.outcomes.length; i++) {
        const preview = makeSingleEventContainer(true);
        preview.innerHTML = '';
        const row = makeEventRow(
            `preview${i}`, cachedArenaEvent.outcomes[i],
            cachedArenaEvent.uploaded);
        preview.appendChild(row);

        const removeButton = document.createElement('img');
        removeButton.src = 'https://www.spikeybot.com/hg/trashCan.png';
        removeButton.classList.add('removeButton');
        removeButton.title = 'Delete Event';
        removeButton.onclick = function() {
          showYesNoBox(
              'Are you sure you wish to delete this event?\nThis cannot be ' +
                  'undone.',
              function() {
                const id = preview.children[0].id.replace('preview', '') * 1;
                cachedArenaEvent.outcomes.splice(id, 1);
                preview.remove();
                for (let i = id + 1; i <= cachedArenaEvent.outcomes.length;
                  i++) {
                  document.getElementById(`preview${i}`).id = `preview${i - 1}`;
                }
              },
              null);
          return false;
        };
        preview.appendChild(removeButton);

        const editButton = document.createElement('img');
        editButton.src = 'https://www.spikeybot.com/hg/pencilIcon.png';
        editButton.classList.add('editButton');
        editButton.title = 'Delete Event';
        preview.appendChild(editButton);
        editButton.onclick = function() {
          const id = row.id.replace('preview', '') * 1;
          const gameEvent = cachedArenaEvent.outcomes[id];
          createEventValues = JSON.parse(JSON.stringify(gameEvent));
          const editContainer = document.createElement('div');
          editContainer.classList.add('singleEventContainer');
          makeCreateEventContainer(editContainer, gameEvent.id, (_, evt) => {
            evt.creator = user.id;
            evt.parentId = cachedArenaEvent.id;
            evt.id = gameEvent.id;
            const par = cachedArenaEvent;
            const index =
                par.outcomes.findIndex((el) => el.id === gameEvent.id);
            par.outcomes[index] = Object.assign(createEventValues, evt);
            createEventValues = {};
            makeCreateWeaponEventContainer(container);
          }, true);

          const backButton = document.createElement('button');
          backButton.textContent = 'Cancel';
          backButton.onclick = function() {
            createEventEditing = false;
            createEventValues = {};
            makeCreateWeaponEventContainer(container);
          };
          editContainer.appendChild(backButton);
          preview.parentNode.replaceChild(editContainer, preview);
          return false;
        };

        container.appendChild(preview);
      }
    } else if (cachedArenaEvent && !cachedArenaEvent.outcomes) {
      cachedArenaEvent.outcomes = [];
    }

    const createEvent = makeSingleEventContainer(true);
    container.appendChild(createEvent);

    const submitButton = document.createElement('button');
    submitButton.id = 'submitArenaEventButton';
    submitButton.innerHTML = 'Submit';
    submitButton.onclick = function() {
      checksPassed = 0;
      confirmEvent();
    };
    container.appendChild(submitButton);
    let checksPassed = 0;
    /**
     * Confirm that all values are allowed, and the values user has intended.
     */
    function confirmEvent() {
      /**
       * Fired once user has confirmed the event submission.
       * @private
       * @fires createEvent
       * @fires replaceEvent
       */
      function confirmSubmit() {
        delete cachedArenaEvent.uploaded;
        cachedArenaEvent.type = 'weapon';
        cachedArenaEvent.outcomes.forEach((el) => el.creator = user.id);
        console.log(cachedArenaEvent);
        if (cachedArenaEvent.id) {
          const id = cachedArenaEvent.id;
          socket.emit('replaceEvent', cachedArenaEvent, (err) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to edit weapon event.');
              return;
            }
            getEvent(id, true);
            cachedArenaEvent = {};
            makeChooseEventContainer(container);
          });
        } else {
          socket.emit('createEvent', cachedArenaEvent, (err, eId) => {
            if (err) {
              console.error(err, eId);
              showMessageBox('Failed to create weapon event.');
              return;
            }
            cachedArenaEvent = {};
            makeChooseEventContainer(container);
            socket.emit('addEvent', selectedGuild, 'weapon', eId, (err) => {
              if (err) {
                console.error(err);
                showMessageBox(
                    'Created event, but failed to add it to server.');
                return;
              }
            });
          });
        }
      };

      const eventWeaponName = document.getElementById('eventStartMessageInput');
      if (eventWeaponName.value.length == 0) {
        showMessageBox('You have not entered a name for this weapon.');
      } else if (
        !(checksPassed & (1 << 1)) && cachedArenaEvent.outcomes.length == 0) {
        showYesNoBox(
            'You have not added any events to this weapon, are you sure ' +
                'you wish to do this?<br><br>The weapon event will never' +
                ' be used.',
            function() {
              checksPassed |= 1 << 1;
              confirmEvent();
            },
            null);
      } else if (
        !(checksPassed & (1 << 2)) && createEventEditing) {
        showYesNoBox(
            'You have made edits to the event that you have not submitted. ' +
                'Are you sure you wish to continue?',
            function() {
              checksPassed |= 1 << 2;
              confirmEvent();
            },
            null);
      } else if (
        !(checksPassed & (1 << 3)) &&
          guild.hg.customEventStore.weapon[cachedArenaEvent.id]) {
        showYesNoBox(
            'This weapon already exists. Do you wish to overwrite it?',
            function() {
              checksPassed |= 1 << 3;
              confirmEvent();
            }, null);
      } else {
        confirmSubmit();
      }
    }
  }
  /**
   * Creates the container that shows lets the user create an Arena Event.
   * @private
   * @param {HTMLElement} container The container to replace.
   */
  function makeCreateArenaEventContainer(container) {
    container.innerHTML = '';
    container.style.textAlign = 'left';

    const backButton = document.createElement('button');
    backButton.classList.add('eventBackButton');
    backButton.innerHTML = 'Back';
    backButton.onclick = function() {
      makeChooseEventContainer(container);
    };
    container.appendChild(backButton);

    const title = document.createElement('h2');
    title.innerHTML = 'Arena Event';
    title.style.textAlign = 'center';
    container.appendChild(title);

    if (!cachedArenaEvent) {
      cachedArenaEvent = {};
    }
    const eventStartMessageInput = document.createElement('input');
    eventStartMessageInput.id = 'eventStartMessageInput';
    eventStartMessageInput.type = 'text';
    eventStartMessageInput.placeholder = 'Arena Event Start Message';
    eventStartMessageInput.oninput = function() {
      cachedArenaEvent.message = this.value;
    };
    if (cachedArenaEvent.message) {
      eventStartMessageInput.value = cachedArenaEvent.message;
    }
    container.appendChild(eventStartMessageInput);

    for (let i = 0;
      cachedArenaEvent.outcomes && i < cachedArenaEvent.outcomes.length;
      i++) {
      const preview = makeSingleEventContainer();
      preview.innerHTML = '';
      const row = makeEventRow(
          `preview${i}`, cachedArenaEvent.outcomes[i],
          cachedArenaEvent.uploaded);
      preview.appendChild(row);

      const removeButton = document.createElement('img');
      removeButton.src = 'https://www.spikeybot.com/hg/trashCan.png';
      removeButton.classList.add('removeButton');
      removeButton.title = 'Delete Event';
      preview.appendChild(removeButton);
      removeButton.onclick = function() {
        showYesNoBox(
            'Are you sure you wish to delete this event?\nThis cannot be ' +
                'undone.',
            function() {
              const id = preview.children[0].id.replace('preview', '') * 1;
              cachedArenaEvent.outcomes.splice(id, 1);
              preview.remove();
              for (let i = id + 1; i <= cachedArenaEvent.outcomes.length; i++) {
                document.getElementById(`preview${i}`).id = `preview${i - 1}`;
              }
            },
            null);
        return false;
      };

      const editButton = document.createElement('img');
      editButton.src = 'https://www.spikeybot.com/hg/pencilIcon.png';
      editButton.classList.add('editButton');
      editButton.title = 'Delete Event';
      preview.appendChild(editButton);
      editButton.onclick = function() {
        const id = row.id.replace('preview', '') * 1;
        const gameEvent = cachedArenaEvent.outcomes[id];
        createEventValues = JSON.parse(JSON.stringify(gameEvent));
        const editContainer = document.createElement('div');
        editContainer.classList.add('singleEventContainer');
        makeCreateEventContainer(editContainer, gameEvent.id + id, (_, evt) => {
          evt.creator = user.id;
          evt.parentId = cachedArenaEvent.id;
          evt.id = gameEvent.id;
          const par = cachedArenaEvent;
          const index = par.outcomes.findIndex((el) => el.id === gameEvent.id);
          par.outcomes[index] = Object.assign(createEventValues, evt);
          createEventValues = {};
          makeCreateArenaEventContainer(container);
        });

        const backButton = document.createElement('button');
        backButton.textContent = 'Cancel';
        backButton.onclick = function() {
          createEventEditing = false;
          createEventValues = {};
          makeCreateArenaEventContainer(container);
        };
        editContainer.appendChild(backButton);
        preview.parentNode.replaceChild(editContainer, preview);
        return false;
      };

      container.appendChild(preview);
    }

    const createEvent = makeSingleEventContainer();
    container.appendChild(createEvent);

    const submitButton = document.createElement('button');
    submitButton.id = 'submitArenaEventButton';
    submitButton.innerHTML = 'Submit';
    submitButton.onclick = function() {
      /**
       * Fired once the user has confirmed the event creation.
       * @private
       * @fires createEvent
       * @fires replaceEvent
       */
      function confirmSubmit() {
        console.log(cachedArenaEvent);
        cachedArenaEvent.type = 'arena';
        cachedArenaEvent.outcomes.forEach((el) => el.creator = user.id);
        if (cachedArenaEvent.id) {
          const id = cachedArenaEvent.id;
          socket.emit('replaceEvent', cachedArenaEvent, (err) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to edit arena event.');
              return;
            }
            getEvent(id, true);
            cachedArenaEvent = {};
            makeChooseEventContainer(container);
          });
        } else {
          socket.emit('createEvent', cachedArenaEvent, (err, eId) => {
            if (err) {
              console.error(err, eId);
              showMessageBox('Failed to create arena event.');
              return;
            }
            cachedArenaEvent = {};
            makeChooseEventContainer(container);
            socket.emit('addEvent', selectedGuild, 'arena', eId, (err) => {
              if (err) {
                console.error(err);
                showMessageBox(
                    'Created event, but failed to add it to server.');
                return;
              }
            });
          });
        }
      };
      if (eventStartMessageInput.value.length == 0) {
        showMessageBox('You have not entered a message for this arena event.');
      } else if (cachedArenaEvent.outcomes.length == 0) {
        showYesNoBox(
            'You have not added any events to this arena event, are you sure ' +
                'you wish to do this?<br><br>The arena event will not be used.',
            confirmSubmit, null);
      } else {
        confirmSubmit();
      }
    };
    container.appendChild(submitButton);
  }
  /**
   * Create the container that lets the user upload their event file.
   * @private
   * @param {HTMLElement} container The container to replace.
   */
  function makeUploadEventContainer(container) {
    container.innerHTML = '';
    container.style.textAlign = 'left';

    const backButton = document.createElement('button');
    backButton.classList.add('eventBackButton');
    backButton.innerHTML = 'Back';
    backButton.onclick = function() {
      makeChooseEventContainer(container);
    };
    container.appendChild(backButton);

    const title = document.createElement('h2');
    title.innerHTML = 'Upload Event';
    title.style.textAlign = 'center';
    container.appendChild(title);

    /* eslint-disable-next-line no-unused-vars */
    const guild = guilds[selectedGuild];

    const inputForm = document.createElement('form');
    inputForm.classList.add('uploadForm');

    const inputArea = document.createElement('div');
    inputArea.classList.add('uploadDropZone');
    inputForm.appendChild(inputArea);

    if (typeof inputArea.draggable !== 'undefined' &&
        typeof inputArea.ondragstart !== 'undefined' &&
        typeof inputArea.ondrop !== 'undefined' &&
        typeof window.FormData !== 'undefined' &&
        typeof window.FileReader !== 'undefined') {
      inputArea.classList.add('enabled');
      inputForm.classList.add('enabled');
      const dropHereText = document.createElement('a');
      dropHereText.innerHTML = 'Drop File Here';
      inputArea.appendChild(dropHereText);
      inputArea.appendChild(document.createElement('br'));

      inputForm.addEventListener('dragover', dragOver);
      inputForm.addEventListener('dragenter', dragOver);
      inputForm.addEventListener('dragleave',  dragLeave);
      inputForm.addEventListener('dragend',  dragLeave);
      inputForm.addEventListener('drop', dragDrop);

      /**
       * If a file has been dragged over the drop zone.
       * @private
       * @param {Event} event The event that was fired.
       * @listens HTMLDivElement#dragover
       * @listens HTMLDivElement#dragenter
       */
      function dragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        inputArea.classList.add('dragover');
      }
      /**
       * If a file has been dragged away from the drop zone.
       * @private
       * @param {Event} event The event that was fired.
       * @listens HTMLDivElement#dragleave
       * @listens HTMLDivElement#dragend
       */
      function dragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        inputArea.classList.remove('dragover');
      }
      /**
       * If a file has been dropped in the drop zone.
       * @private
       * @param {Event} event The event that was fired.
       * @listens HTMLDivElement#drop
       */
      function dragDrop(event) {
        dragLeave(event);
        input.files = (event.originalEvent || event).dataTransfer.files;
      }
    }

    /**
     * Handles the received files from the user input.
     * @private
     * @param {FileList} files The files given by the user.
     */
    function filesReceived(files) {
      console.log('File inputted', files);
      const reader = new FileReader();
      reader.onload = function(evt) {
        let parsed;
        try {
          parsed = JSON.parse(evt.target.result);
        } catch (err) {
          console.error('Failed to parse file', evt.target.result);
          showMessageBox(
              'Failed to parse file. Are you sure it is a valid JSON file?');
          return;
        }
        console.log(parsed);
        importUploadedEvent(container, parsed);
      };
      for (let i = 0; i < files.length; i++) {
        reader.readAsText(files[i]);
      }
    }

    const input = document.createElement('input');
    input.type = 'file';
    // input.multiple = true;
    input.accept = 'application/json';
    input.onchange = function(event) {
      filesReceived(input.files);
    };
    inputArea.appendChild(input);
    container.appendChild(inputForm);
  }
  /**
   * Create the container that lets the user select events they have already
   * created.
   * @private
   * @param {HTMLElement} container The container to replace.
   */
  function makePersonalEventContainer(container) {
    for (let i = container.children.length - 1; i >= 0; i--) {
      if (!container.children[i].classList.contains('eventTypeParent')) {
        continue;
      }
      container.children[i].remove();
    }

    container.style.textAlign = 'left';

    let backButton = container.getElementsByClassName('eventBackButton')[0];
    if (!backButton) {
      backButton = document.createElement('button');
      backButton.classList.add('eventBackButton');
      backButton.innerHTML = 'Back';
      backButton.onclick = function() {
        makeChooseEventContainer(container);
      };
      container.appendChild(backButton);
    }

    let title = container.getElementsByClassName('createEventTitle')[0];
    if (!title) {
      title = document.createElement('h2');
      title.style.textAlign = 'center';
      title.classList.add('createEventsTitle');
      container.appendChild(title);
    }
    title.innerHTML = 'Personal Events';

    let eventList = document.getElementById('personalEventList');
    if (!eventList) {
      eventList = document.createElement('div');
      eventList.id = 'personalEventList';
      container.appendChild(eventList);
    }

    fetchPersonalEvents();

    makePersonalEventList(eventList);
  }

  /**
   * Create the list of events that can be added to the server.
   * @private
   * @param {HTMLElement} container The container to fill with the list.
   * @param {number} [page=0] Page to start at.
   */
  function makePersonalEventList(container, page = 0) {
    selectEventPage(
        page || 0, container, personalEvents.map((el) => {
          return {id: el.Id};
        }),
        'custom', 'personal');
  }

  /**
   * Fetch the list of events the user has created.
   * @private
   */
  function fetchPersonalEvents() {
    if (Date.now() - lastPersonalEventFetch < 30000) return;
    lastPersonalEventFetch = Date.now();
    socket.emit('fetchUserEvents', (err, list) => {
      if (err) {
        console.error(err);
        showMessageBox('Failed to fetch personal events.');
        return;
      }
      console.log('Personal Events', list);
      personalEvents = list;
      const container = document.getElementById('personalEventList');
      if (container) makePersonalEventList(container);
    });
  }

  /**
   * Digest the given game event and if it's valid, allow the user to add it.
   * @private
   * @param {HTMLDivElement} container The create event tab container to replace
   * with the UI to allow user confirmation.
   * @param {
   *   SpikeyBot~HungryGames~Event
   *   | SpikeyBot~HungryGames~ArenaEvent
   *   | SpikeyBot~HungryGames~WeaponEvent
   * } gameEvent The event to create a preview of.
   */
  function importUploadedEvent(container, gameEvent) {
    const type = inferEventUploadType(gameEvent);
    if (!type) {
      console.warn('Unable to infer type for event', gameEvent);
      showMessageBox('Invalid event file: Unable to infer event category.');
      makeUploadEventContainer(container);
      return;
    }
    const output = validateEventUploadData(gameEvent, type);
    if (output) {
      console.warn(output, gameEvent);
      showMessageBox('Invalid event file: ' + output, 20000, true);
      makeUploadEventContainer(container);
      return;
    }
    gameEvent.creator = user.id;
    if (typeof gameEvent.id === 'string' && gameEvent.id.startsWith(user.id)) {
      delete gameEvent.id;
    }

    let parentType;
    let parentName;
    if (type == 'normal') {
      parentType = inferEventParentType(gameEvent);
      if (parentType) {
        parentName = inferEventParentName(gameEvent, parentType);
      }
    }

    let finalEvent;
    if (type == 'legacyWeapon') {
      finalEvent = gameEvent[1];
      if (!gameEvent[1].name || gameEvent[1].name.length == 0) {
        gameEvent[1].name = gameEvent[0];
      }
    } else {
      finalEvent = gameEvent;
    }

    if (finalEvent.outcomes) {
      let deleted = false;
      finalEvent.outcomes.forEach((el) => {
        el.creator = user.id;
        if (el.victim && el.victim.weapon && el.victim.weapon.name) {
          deleted = true;
          delete el.victim.weapon;
        }
        if (el.attacker && el.attacker.weapon && el.attacker.weapon.name) {
          deleted = true;
          delete el.attacker.weapon;
        }
      });
      if (deleted) {
        showOkBox(
            'The uploaded file contains weapon information that could not be ' +
            'updated to the newer format automatically.<br><br>Ensure you ' +
            'update the events to use the correct weapon after you submit the' +
            ' event.');
      }
    }

    console.log('Final:', type, parentType, parentName, finalEvent);

    if (!parentName) {
      switch (type) {
        case 'normal':
          createEventValues = finalEvent;
          makeCreateEventContainer(container, 'normalUploaded');
          break;
        case 'weapon':
        case 'legacyWeapon':
          cachedArenaEvent = finalEvent;
          cachedArenaEvent.uploaded = true;
          makeCreateWeaponEventContainer(container);
          break;
        case 'arena':
          cachedArenaEvent = finalEvent;
          cachedArenaEvent.uploaded = true;
          makeCreateArenaEventContainer(container);
          break;
      }
    } else {
      showYesNoBox(
          'This event appears to have been a part of a previous ' + parentType +
              ' event that still exists.<br><br>Would you like to add the ' +
              'event you uploaded into the old one?<br><br>' +
              escapeHtml(parentName),
          function() {
            createEventValues = finalEvent;
            cachedArenaEvent = {};
            switch (parentType) {
              case 'weapon':
                makeCreateWeaponEventContainer(container);
                break;
              case 'arena':
                makeCreateArenaEventContainer(container);
                break;
            }
          },
          function() {
            createEventValues = finalEvent;
            makeCreateEventContainer(container, 'normalUploaded');
          });
    }
  }
  /**
   * Make the container for creating a single event, that once submitted will
   * show a preview, and a new create event container.
   * @private
   * @param {boolean} [isWeapon=false] Is this a weapon event.
   * @return {HTMLDivElement} The container created.
   */
  function makeSingleEventContainer(isWeapon = false) {
    /**
     * The handler for user submitting the single event.
     * @private
     * @param {string} type The type of event (usually player).
     * @param {object} evt The event data.
     */
    function submitCB(type, evt) {
      if (cachedArenaEvent.outcomes) {
        for (let i = 0; i < cachedArenaEvent.outcomes.length; i++) {
          const el = cachedArenaEvent.outcomes[i];
          if (el.message == evt.message &&
              el.victim.count == evt.victim.count &&
              el.attacker.count == evt.attacker.count &&
              el.victim.outcome == evt.victim.outcome &&
              el.attacker.outcome == evt.attacker.outcome) {
            showMessageBox('Failed to create event. Event already exists.');
            return;
          }
        }
      } else {
        cachedArenaEvent.outcomes = [];
      }
      container.innerHTML = '';
      container.appendChild(
          makeEventRow('preview' + cachedArenaEvent.outcomes.length, evt));
      cachedArenaEvent.outcomes.push(evt);
      const removeButton = document.createElement('img');
      removeButton.src = 'https://www.spikeybot.com/hg/trashCan.png';
      removeButton.classList.add('removeButton');
      removeButton.title = 'Delete Event';
      removeButton.onclick = function() {
        showYesNoBox(
            'Are you sure you wish to delete this event?\nThis cannot be ' +
                'undone.',
            function() {
              const id = container.children[0].id.replace('preview', '') * 1;
              cachedArenaEvent.outcomes.splice(id, 1);
              container.remove();
              for (let i = id + 1; i <= cachedArenaEvent.outcomes.length; i++) {
                document.getElementById(`preview${i}`).id = `preview${i - 1}`;
              }
            },
            null);
        return false;
      };
      container.appendChild(removeButton);
      createEventValues = {};
      container.parentNode.appendChild(makeSingleEventContainer(isWeapon));
    }

    const container = document.createElement('div');
    container.classList.add('singleEventContainer');
    makeCreateEventContainer(container, 'normalSingle', submitCB, isWeapon);
    return container;
  }
  /**
   * Create a preview for an event as the user is creating it. Updates
   * `#createEventPreview`.
   * @private
   * @param {string} id The editing container ID to update.
   */
  function updateEventPreview(id) {
    try {
      const gameEvent = {id: createEventValues.id, victim: {}, attacker: {}};

      gameEvent.message =
          document.getElementById('createEventMessage' + id).value;
      gameEvent.victim.count =
          document.getElementById('createEventNumVictim' + id).value;
      gameEvent.attacker.count =
          document.getElementById('createEventNumAttacker' + id).value;
      gameEvent.victim.outcome =
          document.getElementById('createEventVictimOutcome' + id).value;
      gameEvent.attacker.outcome =
          document.getElementById('createEventAttackerOutcome' + id).value;
      gameEvent.victim.killer =
          document.getElementById('createEventVictimKiller' + id).checked;
      gameEvent.attacker.killer =
          document.getElementById('createEventAttackerKiller' + id).checked;
      gameEvent.attacker.weapon = {};
      gameEvent.victim.weapon = {};
      gameEvent.victim.weapon.id =
          document.getElementById('createEventVictimWeaponSelect' + id).value;
      gameEvent.attacker.weapon.id =
          document.getElementById('createEventAttackerWeaponSelect' + id).value;
      gameEvent.victim.weapon.count =
          document.getElementById('createEventVictimWeaponQuantity' + id).value;
      gameEvent.attacker.weapon.count =
          document.getElementById('createEventAttackerWeaponQuantity' + id)
              .value;

      const consumedCountElement =
          document.getElementById('createEventWeaponConsumed' + id);
      if (consumedCountElement) gameEvent.consumes = consumedCountElement.value;

      createEventValues = gameEvent;

      const preview = document.getElementById('createEventPreview' + id);
      preview.innerHTML = '';
      preview.appendChild(makeEventRow('preview', gameEvent));
      createEventEditing = true;
    } catch (err) {
      console.error(err);
    }
  }
  /**
   * Show a page of events.
   * @private
   * @param {number} page The page number to show (zero-indexed).
   * @param {HTMLElement} container The container to replace with the event
   * page.
   * @param {
   *   SpikeyBot~HungryGames~Event[]
   *   | SpikeyBot~HungryGames~ArenaEvent[]
   *   | SpikeyBot~HungryGames~WeaponEvent[]
   * } eventList The list of all events available.
   * @param {string} category The name of the main event category for use of
   * checking if events will be deletable ('custom' or 'default').
   * @param {string} type The type of events these are (player, bloodbath,
   * weapon, arena).
   */
  function selectEventPage(page, container, eventList, category, type) {
    if (eventList.length == 0) {
      container.innerHTML = '<a class="noEventTag">No events</a>';
      return;
    } else {
      const noEventTag = container.getElementsByClassName('noEventTag')[0];
      if (noEventTag) noEventTag.remove();
    }

    const guild = guilds[selectedGuild];

    const deletable = category === 'custom';

    if (page < 0) page = 0;
    let maxPage = Math.floor((eventList.length - 1) / 10);
    if (type === 'weapon') {
      maxPage = eventList.length - 1;
    } else if (type === 'arena') {
      maxPage = eventList.length - 1;
    }
    if (page > maxPage) page = maxPage;

    container.setAttribute('eventType', type);
    container.setAttribute('eventCategory', category);
    container.setAttribute('page', page);
    container.classList.add('eventPage');

    let title = container.getElementsByClassName(`${type}Title`)[0];
    if (type === 'weapon') {
      container.setAttribute('eventId', eventList[page].id);
      const message = weaponMessage;
      if (!title) {
        title = document.createElement('a');
        title.classList.add('eventPageTitle');
        title.classList.add(`${type}Title`);
        container.appendChild(title);
      }

      eventList[page] = getEvent(eventList[page].id) || eventList[page];
      title.textContent = eventList[page].name || eventList[page].id ||
          'Wat. Something broke... Impossible!';

      let buttonParent = container.getElementsByClassName(`${type}Buttons`)[0];
      if (!buttonParent) {
        buttonParent = document.createElement('span');
        buttonParent.classList.add(`${type}Buttons`);
        buttonParent.classList.add('majorEventButtons');
        container.appendChild(buttonParent);
      }
      let deleteButton = buttonParent.getElementsByClassName('deleteButton')[0];
      if (!deleteButton) {
        deleteButton = document.createElement('img');
        deleteButton.src = 'https://www.spikeybot.com/hg/trashCan.png';
        deleteButton.classList.add('deleteButton');
        buttonParent.appendChild(deleteButton);
      }
      let removeButton = buttonParent.getElementsByClassName('removeButton')[0];
      if (!removeButton) {
        removeButton = document.createElement('img');
        removeButton.src = 'https://www.spikeybot.com/hg/xIcon.png';
        removeButton.classList.add('removeButton');
        buttonParent.appendChild(removeButton);
      }
      let editButton = buttonParent.getElementsByClassName('editButton')[0];
      if (!editButton) {
        editButton = document.createElement('img');
        editButton.src = 'https://www.spikeybot.com/hg/pencilIcon.png';
        editButton.classList.add('editButton');
        buttonParent.appendChild(editButton);
      }
      if (category !== 'default') {
        deleteButton.style.display = '';
        removeButton.style.display = '';
        editButton.style.display = '';
        if (deletable) {
          removeButton.title = 'Remove Event';
          removeButton.onclick = function() {
            this.disabled = true;
            showYesNoBox(
                'Are you sure you wish to remove this event from this server?',
                () => {
                  socket.emit(
                      'removeEvent', selectedGuild, type, eventList[page].id,
                      (err) => {
                        this.disabled = false;
                        if (err) {
                          console.error(err);
                          showMessageBox('Failed to remove it from server.');
                          return;
                        }
                      });
                },
                null);
            return false;
          };
          if (eventList[page].creator === user.id) {
            deleteButton.title = 'Delete Event';
            editButton.title = 'Edit Event';
            deleteButton.classList.remove('disabled');
            editButton.classList.remove('disabled');

            deleteButton.onclick = function() {
              this.disabled = true;
              showYesNoBox(
                  'Are you sure you wish to delete this event?\nThis cannot ' +
                      'be undone.',
                  () => {
                    socket.emit('deleteEvent', eventList[page].id, (err) => {
                      if (err) {
                        this.disabled = false;
                        console.error(err);
                        showMessageBox('Failed to delete event.');
                        return;
                      }
                      handleEventDeleted(eventList[page].id);
                      socket.emit(
                          'removeEvent', selectedGuild, type,
                          eventList[page].id, (err) => {
                            this.disabled = false;
                            if (err) {
                              console.error(err);
                              showMessageBox(
                                  'Event was deleted, but failed to remove ' +
                                  'it from server.');
                              return;
                            }
                          });
                    });
                  },
                  null);
              return false;
            };

            editButton.onclick = function() {
              const gameEvent = eventList[page];
              const id = gameEvent.parentId || gameEvent.id;
              const evt = getEvent(id);
              cachedArenaEvent = JSON.parse(JSON.stringify(evt));
              cachedArenaEvent.uploaded = true;

              const createTab = document.getElementById('createEvents');
              if (createTab.classList.contains('folded')) {
                foldHandler.apply(createTab.children[0]);
              }

              const editContainer =
                  document.getElementById('createEventsContainer');
              makeCreateWeaponEventContainer(editContainer);
              return false;
            };
          } else if (!eventList[page].creator) {
            deleteButton.title = 'This event may already be deleted.';
            deleteButton.onclick = function() {
              showMessageBox(this.title);
            };
            deleteButton.classList.add('disabled');
            editButton.title =
                'This event may not exist, and thus cannot be edited.';
            editButton.onclick = function() {
              showMessageBox(this.title);
            };
            editButton.classList.add('disabled');
          } else {
            deleteButton.title =
                'You do not own this event, and thus cannot delete it.';
            deleteButton.onclick = function() {
              showMessageBox(this.title);
            };
            deleteButton.classList.add('disabled');
            editButton.title =
                'You do not own this event, and thus cannot edit it.';
            editButton.onclick = function() {
              showMessageBox(this.title);
            };
            editButton.classList.add('disabled');
          }
        } else {
          deleteButton.classList.add('disabled');
          deleteButton.title = 'Unable to delete this event.';
          deleteButton.onclick = undefined;

          removeButton.classList.add('disabled');
          removeButton.title = 'Unable to remove this event.';
          removeButton.onclick = undefined;

          editButton.classList.add('disabled');
          editButton.title = 'Unable to edit this event.';
          editButton.onclick = undefined;
        }
      } else {
        deleteButton.style.display = 'none';
        removeButton.style.display = 'none';
        editButton.style.display = 'none';
      }
      let downloadButton =
          buttonParent.getElementsByClassName('downloadButton')[0];
      if (!downloadButton) {
        downloadButton = document.createElement('a');
        downloadButton.download = 'hgWeaponEvent.json';
        downloadButton.title = 'Download Weapon';
        downloadButton.classList.add('downloadButton');
        buttonParent.appendChild(downloadButton);

        const downloadImage = document.createElement('img');
        downloadImage.src = 'https://www.spikeybot.com/hg/downloadIcon.png';
        downloadButton.appendChild(downloadImage);
      }
      downloadButton.href = 'data:application/json;charset=utf-8,' +
          encodeURIComponent(JSON.stringify(eventList[page], null, 2));

      let disableButton =
          buttonParent.getElementsByClassName('disableEventButton')[0];
      const disabledEvents = guild.hg && guild.hg.disabledEventIds.weapon || [];
      const isEnabled = !disabledEvents.includes(eventList[page].id);
      if (!disableButton) {
        disableButton = document.createElement('button');
        disableButton.classList.add('disableEventButton');
        buttonParent.appendChild(disableButton);
      }
      disableButton.classList.toggle('selected', !isEnabled);
      disableButton.setAttribute('eventId', eventList[page].id);
      disableButton.setAttribute('eventType', 'weapon');
      disableButton.textContent = isEnabled ? 'Enabled' : 'Disabled';
      disableButton.onclick = function(evt) {
        const isEnabled = !this.classList.contains('selected');
        console.log('Toggling', 'weapon', eventList[page].id, !isEnabled);
        socket.emit(
            'toggleEvent', selectedGuild, 'weapon', eventList[page].id,
            !isEnabled, (err) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to toggle event.');
                return;
              }
            });
      };

      if (eventList[page].outcomes) {
        for (let i = 0; i < eventList[page].outcomes.length; i++) {
          const obj = eventList[page].outcomes[i];
          if (!obj.message) {
            obj.message = message.replace(/\{action\}/g, obj.action)
                .replace(/\{weapon\}/g, eventList[page].name);
          }
          obj.cat = 'weapon';
          obj.parentId = eventList[page].id;

          const index = i;
          let row = container.getElementsByClassName(`${type}Row${index}`)[0];
          const doUpdate = !row;
          row = makeEventRow(index, obj, deletable, type, row);
          row.style.display = '';
          row.classList.add(`${type}Row${index}`);
          if (doUpdate) container.appendChild(row);
        }
      }
      const list = container.getElementsByClassName('eventRow');
      const len =
          eventList[page].outcomes && eventList[page].outcomes.length || 0;
      for (let i = list.length - 1; i >= 0 && i >= len; i--) {
        list[i].style.display = 'none';
      }
    } else if (type === 'arena') {
      container.setAttribute('eventId', eventList[page].id);
      eventList[page] = getEvent(eventList[page].id) || eventList[page];
      if (!title) {
        title = document.createElement('a');
        title.classList.add('eventPageTitle');
        title.classList.add(`${type}Title`);
        container.appendChild(title);
      }
      title.textContent = eventList[page].message || eventList[page].id ||
          'Wat. Something broke... Impossible!';

      let buttonParent = container.getElementsByClassName(`${type}Buttons`)[0];
      if (!buttonParent) {
        buttonParent = document.createElement('span');
        buttonParent.classList.add(`${type}Buttons`);
        buttonParent.classList.add('majorEventButtons');
        container.appendChild(buttonParent);
      }
      let deleteButton = buttonParent.getElementsByClassName('deleteButton')[0];
      if (!deleteButton) {
        deleteButton = document.createElement('img');
        deleteButton.src = 'https://www.spikeybot.com/hg/trashCan.png';
        deleteButton.classList.add('deleteButton');
        buttonParent.appendChild(deleteButton);
      }
      let removeButton = buttonParent.getElementsByClassName('removeButton')[0];
      if (!removeButton) {
        removeButton = document.createElement('img');
        removeButton.src = 'https://www.spikeybot.com/hg/xIcon.png';
        removeButton.classList.add('removeButton');
        buttonParent.appendChild(removeButton);
      }
      let editButton = buttonParent.getElementsByClassName('editButton')[0];
      if (!editButton) {
        editButton = document.createElement('img');
        editButton.src = 'https://www.spikeybot.com/hg/pencilIcon.png';
        editButton.classList.add('editButton');
        buttonParent.appendChild(editButton);
      }
      if (category !== 'default') {
        deleteButton.style.display = '';
        removeButton.style.display = '';
        editButton.style.display = '';
        if (deletable) {
          removeButton.title = 'Remove Event';
          removeButton.onclick = function() {
            this.disabled = true;
            showYesNoBox(
                'Are you sure you wish to remove this event from this server?',
                () => {
                  socket.emit(
                      'removeEvent', selectedGuild, type, eventList[page].id,
                      (err) => {
                        this.disabled = false;
                        if (err) {
                          console.error(err);
                          showMessageBox('Failed to remove it from server.');
                          return;
                        }
                      });
                },
                null);
            return false;
          };
          if (eventList[page].creator === user.id) {
            deleteButton.title = 'Delete Event';
            editButton.title = 'Edit Event';
            deleteButton.classList.remove('disabled');
            editButton.classList.remove('disabled');

            deleteButton.onclick = function() {
              this.disabled = true;
              showYesNoBox(
                  'Are you sure you wish to delete this event?\nThis cannot ' +
                      'be undone.',
                  () => {
                    socket.emit('deleteEvent', eventList[page].id, (err) => {
                      if (err) {
                        this.disabled = false;
                        console.error(err);
                        showMessageBox('Failed to delete event.');
                        return;
                      }
                      handleEventDeleted(eventList[page].id);
                      socket.emit(
                          'removeEvent', selectedGuild, type,
                          eventList[page].id, (err) => {
                            this.disabled = false;
                            if (err) {
                              console.error(err);
                              showMessageBox(
                                  'Event was deleted, but failed to remove ' +
                                  'it from server.');
                              return;
                            }
                          });
                    });
                  },
                  null);
              return false;
            };

            editButton.onclick = function() {
              const gameEvent = eventList[page];
              const id = gameEvent.parentId || gameEvent.id;
              const evt = getEvent(id);
              cachedArenaEvent = JSON.parse(JSON.stringify(evt));
              cachedArenaEvent.uploaded = true;

              const createTab = document.getElementById('createEvents');
              if (createTab.classList.contains('folded')) {
                foldHandler.apply(createTab.children[0]);
              }

              const editContainer =
                  document.getElementById('createEventsContainer');
              makeCreateArenaEventContainer(editContainer);
              return false;
            };
          } else if (!eventList[page].creator) {
            deleteButton.title = 'This event may already be deleted.';
            deleteButton.onclick = function() {
              showMessageBox(this.title);
            };
            deleteButton.classList.add('disabled');
            editButton.title =
                'This event may not exist, and thus cannot be edited.';
            editButton.onclick = function() {
              showMessageBox(this.title);
            };
            editButton.classList.add('disabled');
          } else {
            deleteButton.title =
                'You do not own this event, and thus cannot delete it.';
            deleteButton.onclick = function() {
              showMessageBox(this.title);
            };
            deleteButton.classList.add('disabled');
            editButton.title =
                'You do not own this event, and thus cannot edit it.';
            editButton.onclick = function() {
              showMessageBox(this.title);
            };
            editButton.classList.add('disabled');
          }
        } else {
          deleteButton.classList.add('disabled');
          deleteButton.title = 'Unable to delete this event.';
          deleteButton.onclick = undefined;

          removeButton.classList.add('disabled');
          removeButton.title = 'Unable to remove this event.';
          removeButton.onclick = undefined;

          editButton.classList.add('disabled');
          editButton.title = 'Unable to edit this event.';
          editButton.onclick = undefined;
        }
      } else {
        deleteButton.style.display = 'none';
        removeButton.style.display = 'none';
        editButton.style.display = 'none';
      }
      let downloadButton =
          buttonParent.getElementsByClassName('downloadButton')[0];
      if (!downloadButton) {
        downloadButton = document.createElement('a');
        downloadButton.download = 'hgArenaEvent.json';
        downloadButton.title = 'Download Arena Event';
        downloadButton.classList.add('downloadButton');
        buttonParent.appendChild(downloadButton);

        const downloadImage = document.createElement('img');
        downloadImage.src = 'https://www.spikeybot.com/hg/downloadIcon.png';
        downloadButton.appendChild(downloadImage);
      }
      downloadButton.href = 'data:application/json;charset=utf-8,' +
          encodeURIComponent(JSON.stringify(eventList[page], null, 2));

      let disableButton =
          buttonParent.getElementsByClassName('disableEventButton')[0];
      const disabledEvents = guild.hg && guild.hg.disabledEventIds.arena || [];
      const isEnabled = !disabledEvents.includes(eventList[page].id);
      if (!disableButton) {
        disableButton = document.createElement('button');
        disableButton.classList.add('disableEventButton');
        buttonParent.appendChild(disableButton);
      }
      disableButton.classList.toggle('selected', !isEnabled);
      disableButton.setAttribute('eventId', eventList[page].id);
      disableButton.setAttribute('eventType', 'arena');
      disableButton.textContent = isEnabled ? 'Enabled' : 'Disabled';
      disableButton.onclick = function(evt) {
        const isEnabled = !this.classList.contains('selected');
        console.log('Toggling', 'arena', eventList[page].id, !isEnabled);
        socket.emit(
            'toggleEvent', selectedGuild, 'arena', eventList[page].id,
            !isEnabled, (err) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to toggle event.');
                return;
              }
            });
      };

      let sliderParent =
          container.getElementsByClassName(`${type}SliderParent`)[0];
      if (!sliderParent) {
        sliderParent = document.createElement('div');
        sliderParent.classList.add(`${type}SliderParent`);
        container.appendChild(sliderParent);
      }
      const slider =
          sliderParent.getElementsByClassName('multiValueSliderParent')[0];
      let created;
      if (eventList[page].outcomeProbs) {
        created = makeDeathRateSlider(eventList[page].outcomeProbs, !deletable);
      } else if (guild && guild.hg && guild.hg.options.arenaOutcomeProbs) {
        created =
            makeDeathRateSlider(guild.hg.options.arenaOutcomeProbs, !deletable);
      } else {
        created = makeDeathRateSlider(
            defaultOptions.arenaOutcomeProbs.value, !deletable);
      }
      if (slider) {
        sliderParent.replaceChild(created, slider);
      } else {
        sliderParent.insertBefore(created, sliderParent.children[0]);
      }
      let submit = sliderParent.getElementsByClassName('submit')[0];
      if (!submit) {
        submit = document.createElement('input');
        submit.type = 'button';
        submit.classList.add('submit');
        submit.value = 'Submit';
        submit.name = 'outcomeProbs';
        submit.style.marginLeft = '4px';
        sliderParent.appendChild(submit);
      }
      submit.style.display = deletable ? '' : 'none';
      submit.onclick = function(event) {
        const parent = this.parentNode;
        const sliders = parent.getElementsByTagName('input');
        const probs =
            (guild && guild.hg && guild.hg.options.arenaOutcomeProbs) || {};
        let anyDifferent = false;
        for (let i = 0; i < sliders.length; i++) {
          let val = sliders[i].value * 1;
          if (i > 0) {
            val -= sliders[i - 1].value * 1 + 1;
          }
          if (typeof defaultOptions.arenaOutcomeProbs.value[sliders[i].name] ===
              'undefined') {
            continue;
          }
          if (probs[sliders[i].name] == val) {
            continue;
          }
          anyDifferent = true;
          probs[sliders[i].name] = val;
        }
        if (!anyDifferent) {
          return;
        } else {
          eventList[page].outcomeProbs = probs;
        }
        const evt = eventList[page];
        console.log('Replacing event', page, evt);
        socket.emit('replaceEvent', evt, (err) => {
          if (err) {
            console.error('Failed to replace event', evt.id, err);
            showMessageBox('Failed to edit event.');
            return;
          }
          console.log('Event replaced', page, evt);
          getEvent(evt.id, true);
        });
      };

      let reset = sliderParent.getElementsByClassName('reset')[0];
      if (!reset) {
        reset = document.createElement('input');
        reset.type = 'button';
        reset.classList.add('reset');
        reset.value = 'Default';
        reset.name = 'outcomeProbs';
        reset.style.marginLeft = '4px';
        sliderParent.appendChild(reset);
      }
      reset.style.display = deletable ? '' : 'none';
      reset.onclick = function(event) {
        const evt = eventList[page];
        evt.outcomeProbs = null;
        console.log('Replacing event', page, evt);
        socket.emit('replaceEvent', evt, (err) => {
          if (err) {
            console.error('Failed to replace event', evt.id, err);
            showMessageBox('Failed to edit event.');
            return;
          }
          console.log('Event replaced', page, evt);
          getEvent(evt.id, true);
        });
      };

      if (eventList[page].outcomes) {
        for (let i = 0; i < eventList[page].outcomes.length; i++) {
          const obj = eventList[page].outcomes[i];
          obj.cat = 'arena';
          obj.parentId = eventList[page].id;

          const index = i;
          let row = container.getElementsByClassName(`${type}Row${index}`)[0];
          const doUpdate = !row;
          row = makeEventRow(index, obj, deletable, type, row);
          row.style.display = '';
          row.classList.add(`${type}Row${index}`);
          if (doUpdate) container.appendChild(row);
        }
      }
      const list = container.getElementsByClassName('eventRow');
      const len =
          eventList[page].outcomes && eventList[page].outcomes.length || 0;
      for (let i = list.length - 1; i >= 0 && i >= len; i--) {
        list[i].style.display = 'none';
      }
    } else {
      container.removeAttribute('eventId');
      if (title) title.remove();
      for (let i = page * 10; i < page * 10 + 10; i++) {
        const index = i - page * 10;
        let row = container.getElementsByClassName(`${type}Row${index}`)[0];
        const doUpdate = !row;
        if (i >= eventList.length) {
          if (row) row.style.display = 'none';
        } else {
          eventList[i] = getEvent(eventList[i].id) || eventList[i];
          row = makeEventRow(index, eventList[i], deletable, type, row);
          row.style.display = '';
          row.classList.add(`${type}Row${index}`);
          if (doUpdate) container.appendChild(row);
        }
      }
    }

    let firstPageButton =
        document.getElementById(`${category}${type}FirstPageButton`);
    if (!firstPageButton) {
      firstPageButton = document.createElement('button');
      firstPageButton.id = `${category}${type}FirstPageButton`;
      firstPageButton.innerHTML = '<<';
      firstPageButton.onclick = function() {
        selectEventPage(0, container, eventList, category, type);
      };
    }
    container.appendChild(firstPageButton);

    let previousPageButton =
        document.getElementById(`${category}${type}PreviousPageButton`);
    if (!previousPageButton) {
      previousPageButton = document.createElement('button');
      previousPageButton.id = `${category}${type}PreviousPageButton`;
      previousPageButton.innerHTML = '<';
    }
    container.appendChild(previousPageButton);
    previousPageButton.onclick = function() {
      selectEventPage(page - 1, container, eventList, category, type);
    };

    let pageNum =
        document.getElementById(`${category}${type}PageNum`);
    if (!pageNum) {
      pageNum = document.createElement('select');
      pageNum.id = `${category}${type}PageNum`;
      pageNum.onchange = function() {
        selectEventPage(this.value, container, eventList, category, type);
      };
    }
    container.appendChild(pageNum);
    if (pageNum.children.length != maxPage + 1) {
      for (let i = pageNum.children.length - 1; i >= 0; i--) {
        pageNum.children[i].remove();
      }
      for (let i = 0; i <= maxPage; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${i+1} / ${maxPage+1}`;
        pageNum.appendChild(opt);
      }
    }
    pageNum.value = page;

    let nextPageButton =
        document.getElementById(`${category}${type}NextPageButton`);
    if (!nextPageButton) {
      nextPageButton = document.createElement('button');
      nextPageButton.id = `${category}${type}NextPageButton`;
      nextPageButton.innerHTML = '>';
    }
    container.appendChild(nextPageButton);
    nextPageButton.onclick = function() {
      selectEventPage(page + 1, container, eventList, category, type);
    };

    let lastPageButton =
        document.getElementById(`${category}${type}LastPageButton`);
    if (!lastPageButton) {
      lastPageButton = document.createElement('button');
      lastPageButton.id = `${category}${type}LastPageButton`;
      lastPageButton.innerHTML = '>>';
      lastPageButton.onclick = function() {
        selectEventPage(maxPage, container, eventList, category, type);
      };
    }
    container.appendChild(lastPageButton);
  }
  /**
   * Create a single event row.
   * @private
   * @param {string} id The id of this event.
   * @param {SpikeyBot~HungryGames~Event} gameEvent the event so show.
   * @param {boolean} deletable Is this event able to be deleted by the user in
   * the current view.
   * @param {string} type The type of event this is, required to make this
   * deletable (player, bloodbath, arena, weapon).
   * @param {HTMLElement} row Existing element to update.
   * @return {HTMLDivElement} The row representing this game event.
   */
  function makeEventRow(id, gameEvent, deletable, type, row) {
    const fullId =
        (gameEvent.parentId ? `${gameEvent.parentId}/` : '') + gameEvent.id;
    if (!row) {
      row = document.createElement('div');
      row.id = id;
      row.classList.add('member');
      row.classList.add('eventRow');
    }
    row.setAttribute('eventId', fullId);
    if (gameEvent.parentId) {
      row.setAttribute('parentId', gameEvent.parentId);
    } else {
      row.removeAttribute('parentId');
    }
    row.classList.toggle('deletable', deletable);
    row.classList.toggle('deleted', gameEvent.deleted || false);
    row.setAttribute('eventType', type);

    const victimTag = makeTag('victim', 'blue');
    const attackerTag = makeTag('attacker', 'red');
    const deadTag = makeTag('dead', 'gray');
    const ownerTag = makeTag('owner', 'orange');

    let hrMessage = row.getElementsByClassName('eventMessageCell')[0];
    if (!hrMessage) {
      hrMessage = document.createElement('a');
      hrMessage.classList.add('eventMessageCell');
      row.appendChild(hrMessage);
    }
    if (!gameEvent.message && gameEvent.action) {
      gameEvent.message = weaponMessage.replace(/\{action\}/g, gameEvent.action)
          .replace(/\{weapon\}/g, gameEvent.name);
    }
    hrMessage.textContent = gameEvent.name || gameEvent.message || gameEvent.id;

    hrMessage.innerHTML =
        hrMessage.innerHTML.replace(/\{victim\}/g, victimTag.outerHTML)
            .replace(/\{attacker\}/g, attackerTag.outerHTML)
            .replace(/\{owner\}/g, ownerTag.outerHTML)
            .replace(/\{dead\}/g, deadTag.outerHTML);

    hrMessage.innerHTML = hrMessage.innerHTML.replace(
        /\[([VDCA])([^\|]*\|[^\]]*)\]/g, function(str, p1, p2) {
          let color = 'thin';
          if (p1 === 'V') {
            color += 'blue';
            if (gameEvent.victim.count > 0) {
              const split = p2.split('|');
              if (gameEvent.victim.count == 1) {
                p2 = split[0];
              } else {
                p2 = split[1];
              }
            }
          } else if (p1 === 'A') {
            color += 'red';
            if (gameEvent.attacker.count > 0) {
              const split = p2.split('|');
              if (gameEvent.attacker.count == 1) {
                p2 = split[0];
              } else {
                p2 = split[1];
              }
            }
          } else if (p1 === 'D') {
            color += 'gray';
          } else if (p1 === 'C') {
            color += 'orange';
          }
          const tag = makeTag(p2, color, '[', ']');
          return tag.outerHTML;
        });


    let attackerInfo = row.getElementsByClassName('attackerInfoRow')[0];
    const updateAttacker = !attackerInfo;
    if (gameEvent.attacker && gameEvent.attacker.count != 0) {
      attackerInfo = makeAVInfo(
          'attacker', gameEvent.attacker.count, gameEvent.attacker.outcome,
          gameEvent.attacker.weapon, attackerInfo);
    } else {
      attackerInfo = makeAVInfo('attacker', 0, 'nothing', null, attackerInfo);
    }
    if (!gameEvent.attacker) {
      attackerInfo.style.display = 'none';
    } else {
      attackerInfo.style.display = '';
    }
    attackerInfo.classList.add('attackerInfoRow');
    if (updateAttacker) row.appendChild(attackerInfo);

    let victimInfo = row.getElementsByClassName('victimInfoRow')[0];
    const updateVictim = !victimInfo;
    if (gameEvent.victim && gameEvent.victim.count != 0) {
      victimInfo = makeAVInfo(
          'victim', gameEvent.victim.count, gameEvent.victim.outcome,
          gameEvent.victim.weapon, victimInfo);
    } else if (gameEvent.outcomes) {
      victimInfo = makeAVInfo(
          'outcome', gameEvent.outcomes.length, '', null, victimInfo);
    } else {
      victimInfo = makeAVInfo('victim', 0, 'nothing', null, victimInfo);
    }
    victimInfo.classList.add('victimInfoRow');
    if (updateVictim) row.appendChild(victimInfo);

    let consumableRow = row.getElementsByClassName('consumableCell')[0];
    if (!consumableRow) {
      consumableRow = document.createElement('div');
      consumableRow.classList.add('avCell');
      consumableRow.classList.add('consumableCell');
      row.appendChild(consumableRow);
    }
    if (gameEvent.consumes) {
      consumableRow.textContent = 'Weapon owner loses ' + gameEvent.consumes +
          ' consumable' + (gameEvent.consumes == 1 ? '.' : 's.');
    } else {
      consumableRow.textContent = '';
    }

    let creatorRow = row.getElementsByClassName('creatorInfo')[0];
    if (!creatorRow) {
      creatorRow = document.createElement('div');
      creatorRow.classList.add('creatorInfo');
      row.appendChild(creatorRow);
    }
    creatorRow.setAttribute('userId', gameEvent.creator);
    if (gameEvent.creator) {
      creatorRow.textContent = `Creator: ${findMember(gameEvent.creator).name}`;
    } else {
      creatorRow.textContent = '';
    }

    let buttonRow = row.getElementsByClassName('eventButtonRow')[0];
    if (!buttonRow) {
      buttonRow = document.createElement('div');
      buttonRow.classList.add('eventButtonRow');
      row.appendChild(buttonRow);
    }
    let deleteButton = buttonRow.getElementsByClassName('deleteButton')[0];
    if (!deleteButton) {
      deleteButton = document.createElement('img');
      deleteButton.src = 'https://www.spikeybot.com/hg/trashCan.png';
      deleteButton.classList.add('deleteButton');
      buttonRow.appendChild(deleteButton);
    }
    let removeButton = buttonRow.getElementsByClassName('removeButton')[0];
    if (!removeButton) {
      removeButton = document.createElement('img');
      removeButton.src = 'https://www.spikeybot.com/hg/xIcon.png';
      removeButton.classList.add('removeButton');
      buttonRow.appendChild(removeButton);
    }
    let editButton = buttonRow.getElementsByClassName('editButton')[0];
    if (!editButton) {
      editButton = document.createElement('img');
      editButton.src = 'https://www.spikeybot.com/hg/pencilIcon.png';
      editButton.classList.add('editButton');
      buttonRow.appendChild(editButton);
    }
    if (type) {
      removeButton.style.display = '';
      deleteButton.style.display = '';
      editButton.style.display = '';
      if (deletable) {
        if (['bloodbath', 'player', 'normal'].includes(type)) {
          removeButton.classList.remove('disabled');
          removeButton.title = 'Remove Event From Server';
          removeButton.onclick = function() {
            const more = gameEvent.creator === user.id ?
                '' :
                '<br>You will need to ask the creator to add it again.';
            showYesNoBox(
                'Are you sure you wish to remove this event from this server?' +
                    more,
                () => {
                  this.disabled = true;
                  socket.emit(
                      'removeEvent', selectedGuild, type, fullId, (err) => {
                        this.disabled = false;
                        if (err) {
                          console.error(err);
                          showMessageBox('Failed to remove it from server.');
                          return;
                        }
                      });
                },
                null);
            return false;
          };
        } else {
          removeButton.classList.add('disabled');
          removeButton.title = 'Unable to remove this event.';
          removeButton.onclick = undefined;
        }
        if (gameEvent.creator === user.id) {
          deleteButton.title = 'Delete Event';
          editButton.title = 'Edit Event';
          deleteButton.classList.remove('disabled');
          editButton.classList.remove('disabled');

          deleteButton.onclick = function() {
            showYesNoBox(
                'Are you sure you wish to completely delete this event?\nThis' +
                    ' cannot be undone.',
                () => {
                  this.disabled = true;
                  row.classList.add('deleted');
                  socket.emit('deleteEvent', fullId, (err) => {
                    if (err) {
                      this.disabled = false;
                      row.classList.remove('deleted');
                      console.error(err);
                      showMessageBox('Failed to delete event.');
                      return;
                    }
                    handleEventDeleted(fullId);
                    if (type === 'personal') return;
                    socket.emit(
                        'removeEvent', selectedGuild, type, fullId, (err) => {
                          this.disabled = false;
                          if (err) {
                            console.error(err);
                            showMessageBox(
                                'Event was deleted, but failed to remove ' +
                                'it from server.');
                            return;
                          }
                        });
                  });
                },
                null);
            return false;
          };
          editButton.onclick = function() {
            if ('normal' === gameEvent.type) {
              createEventValues = JSON.parse(JSON.stringify(gameEvent));
              const classes = row.getAttribute('class').split(' ');
              const editContainer = document.createElement('div');
              editContainer.classList.add('singleEventContainer');
              const mkId = gameEvent.id || id;
              makeCreateEventContainer(editContainer, mkId, (type, evt) => {
                evt.id = gameEvent.id;
                if (gameEvent.parentId) {
                  evt.creator = user.id;
                  const par = getEvent(gameEvent.parentId);
                  const index = par.outcomes.findIndex(
                      (el) => el.id === gameEvent.id);
                  const old = par.outcomes[index];
                  par.outcomes[index] =
                      Object.assign(createEventValues, evt);
                  console.log(par, evt, createEventValues);
                  socket.emit('replaceEvent', par, (err) => {
                    if (err) {
                      console.error(err);
                      showMessageBox('Failed to edit event.');
                      par.outcomes[index] = old;
                      return;
                    }
                    createEventValues = {};
                    const newRow = makeEventRow(id, evt, deletable, type);
                    classes.forEach((el) => newRow.classList.add(el));
                    editContainer.parentNode.replaceChild(
                        newRow, editContainer);
                  });
                } else {
                  socket.emit('replaceEvent', evt, (err) => {
                    if (err) {
                      console.error(err);
                      showMessageBox('Failed to edit event.');
                      return;
                    }
                    eventStore[gameEvent.id] = evt;
                    createEventValues = {};
                    const newRow = makeEventRow(id, evt, deletable, type);
                    classes.forEach((el) => newRow.classList.add(el));
                    editContainer.parentNode.replaceChild(
                        newRow, editContainer);
                  });
                }
              }, type === 'weapon');

              const backButton = document.createElement('button');
              backButton.textContent = 'Cancel';
              backButton.onclick = function() {
                createEventEditing = false;
                createEventValues = {};
                const newRow = makeEventRow(id, gameEvent, deletable, type);
                editContainer.parentNode.replaceChild(newRow, editContainer);
                delete createEventValues.id;
              };
              editContainer.appendChild(backButton);
              row.parentNode.replaceChild(editContainer, row);
            } else {
              const id = gameEvent.parentId || gameEvent.id;
              const evt = getEvent(id);
              cachedArenaEvent = JSON.parse(JSON.stringify(evt));

              const createTab = document.getElementById('createEvents');
              if (createTab.classList.contains('folded')) {
                foldHandler.apply(createTab.children[0]);
              }

              const editContainer =
                  document.getElementById('createEventsContainer');
              if (gameEvent.type === 'arena') {
                makeCreateArenaEventContainer(editContainer);
              } else if (gameEvent.type === 'weapon') {
                makeCreateWeaponEventContainer(editContainer);
              } else {
                console.error('Unknown edit type', gameEvent.type);
              }
            }
            return false;
          };
        } else if (!gameEvent.creator) {
          deleteButton.title = 'This event may already be deleted.';
          deleteButton.onclick = function() {
            showMessageBox(this.title);
          };
          deleteButton.classList.add('disabled');
          editButton.title =
              'This event may not exist, and thus cannot be edited.';
          editButton.onclick = function() {
            showMessageBox(this.title);
          };
          editButton.classList.add('disabled');
        } else {
          deleteButton.title =
              'You do not own this event, and thus cannot delete it.';
          deleteButton.onclick = function() {
            showMessageBox(this.title);
          };
          deleteButton.classList.add('disabled');
          editButton.title =
              'You do not own this event, and thus cannot edit it.';
          editButton.onclick = function() {
            showMessageBox(this.title);
          };
          editButton.classList.add('disabled');
        }
      } else {
        removeButton.classList.add('disabled');
        removeButton.title = 'Unable to remove this event.';
        removeButton.onclick = undefined;
        deleteButton.classList.add('disabled');
        deleteButton.title = 'Unable to delete this event.';
        deleteButton.onclick = undefined;
        editButton.classList.add('disabled');
        editButton.title = 'Unable to edit this event.';
        editButton.onclick = undefined;
      }
    } else {
      removeButton.style.display = 'none';
      deleteButton.style.display = 'none';
      editButton.style.display = 'none';
    }
    if (type === 'personal') removeButton.style.display = 'none';
    let downloadButton = buttonRow.getElementsByClassName('downloadButton')[0];
    if (!downloadButton) {
      downloadButton = document.createElement('a');
      downloadButton.src = 'https://www.spikeybot.com/hg/downloadIcon.png';
      downloadButton.title = 'Download Event';
      downloadButton.download = 'hgEvent.json';
      downloadButton.classList.add('downloadButton');
      buttonRow.appendChild(downloadButton);

      const downloadImage = document.createElement('img');
      downloadImage.src = 'https://www.spikeybot.com/hg/downloadIcon.png';
      downloadButton.appendChild(downloadImage);
    }
    downloadButton.href = 'data:application/json;charset=utf-8,' +
        encodeURIComponent(JSON.stringify(gameEvent, null, 2));

    const guild = guilds[selectedGuild];
    let disableButton = row.getElementsByClassName('disableEventButton')[0];
    if (type && type !== 'personal') {
      if (guild && guild.hg) {
        const disabledEvents =
            guild.hg.disabledEventIds && guild.hg.disabledEventIds[type] || [];
        const isEnabled = !disabledEvents.includes(fullId);
        if (!disableButton) {
          disableButton = document.createElement('button');
          disableButton.classList.add('disableEventButton');
        }
        disableButton.style.display = '';
        disableButton.setAttribute('eventId', fullId);
        disableButton.setAttribute('eventType', type);
        disableButton.classList.toggle('selected', !isEnabled);
        disableButton.textContent = isEnabled ? 'Enabled' : 'Disabled';
        disableButton.onclick = function(evt) {
          const isEnabled = !this.classList.contains('selected');
          console.log('Toggling', type, fullId, !isEnabled);
          socket.emit(
              'toggleEvent', selectedGuild, type, fullId, !isEnabled, (err) => {
                if (err) {
                  console.error(err);
                  showMessageBox('Failed to toggle event.');
                  return;
                }
              });
        };

        buttonRow.appendChild(disableButton);
      } else if (disableButton) {
        disableButton.style.display = 'none';
      }
    } else if (disableButton) {
      disableButton.style.display = 'none';
    }

    let addButton = row.getElementsByClassName('addEventButton')[0];
    if (type === 'personal') {
      if (addButton) addButton.style.display = '';
      if (gameEvent.type === 'normal') {
        if (addButton && addButton.tagName !== 'SELECT') {
          addButton.remove();
          addButton = null;
        }
        if (!addButton) addButton = document.createElement('select');
        addButton.classList.add('addEventButton');

        let none = addButton.getElementsByClassName('addToNone')[0];
        if (!none) {
          none = document.createElement('option');
          none.classList.add('addToNone');
          none.value = '';
          none.textContent = 'Add to ' + (guild && guild.name || '...');
          addButton.appendChild(none);
        }

        let bloodbath = addButton.getElementsByClassName('addToBloodbath')[0];
        if (!bloodbath) {
          bloodbath = document.createElement('option');
          bloodbath.classList.add('addToBloodbath');
          bloodbath.value = 'bloodbath';
          bloodbath.textContent = 'Bloodbath event';
          addButton.appendChild(bloodbath);
        }
        bloodbath.disabled = !guild || !guild.hg ||
            guild.hg.customEventStore.bloodbath.includes(gameEvent.id);

        let player = addButton.getElementsByClassName('addToPlayer')[0];
        if (!player) {
          player = document.createElement('option');
          player.classList.add('addToPlayer');
          player.value = 'player';
          player.textContent = 'Player event';
          addButton.appendChild(player);
        }
        player.disabled = !guild || !guild.hg ||
            guild.hg.customEventStore.player.includes(gameEvent.id);

        addButton.onclick = undefined;
        addButton.onchange = function() {
          if (this.value === '') return;
          socket.emit(
              'addEvent', selectedGuild, this.value, gameEvent.id, (err) => {
                if (err) {
                  console.error(err);
                  showMessageBox('Failed to add event to server.');
                  return;
                }
                this.children[this.selectedIndex].disabled = true;
                this.value = '';
                addButton.disabled = player.disabled && bloodbath.disabled;
              });
        };
        addButton.disabled = player.disabled && bloodbath.disabled;
      } else {
        if (addButton && addButton.tagName !== 'BUTTON') {
          addButton.remove();
          addButton = null;
        }
        if (!addButton) addButton = document.createElement('button');
        addButton.classList.add('addEventButton');
        addButton.textContent = 'Add to ' + (guild && guild.name || '...');
        addButton.disabled = !guild || !guild.hg ||
            !guild.hg.customEventStore[gameEvent.type] ||
            guild.hg.customEventStore[gameEvent.type].includes(gameEvent.id);

        addButton.onclick = function() {
          socket.emit(
              'addEvent', selectedGuild, gameEvent.type, gameEvent.id,
              (err) => {
                if (err) {
                  console.error(err);
                  showMessageBox('Failed to add event to server.');
                  return;
                }
                makeEventRow(id, gameEvent, deletable, type, row);
              });
        };
      }
      buttonRow.insertBefore(
          addButton, (disableButton && downloadButton || {}).nextSibling);
    } else if (addButton) {
      addButton.style.display = 'none';
    }

    return row;
  }
  /**
   * Format a tag as a bubble.
   * @private
   * @param {string} message The message in the tag bubble.
   * @param {string} color The color name of this tag. Color must exist as a CSS
   * class.
   * @param {string} [openBracket='{'] The character to use as the open bracket
   * if the user copies the tag string.
   * @param {string} [closeBracket='{'] The character to use as the close
   * bracket if the user copies the tag string.
   * @return {HTMLSpanElement} The formatted tag.
   */
  function makeTag(message, color, openBracket = '{', closeBracket = '}') {
    const bracketOpen = document.createElement('span');
    bracketOpen.textContent = openBracket;
    bracketOpen.style.fontSize = '0';
    const bracketClose = document.createElement('span');
    bracketClose.textContent = closeBracket;
    bracketClose.style.fontSize = '0';
    const tag = document.createElement('a');
    tag.appendChild(bracketOpen);
    tag.appendChild(document.createTextNode(message));
    tag.appendChild(bracketClose);
    tag.classList.add('tag');
    if (color) tag.classList.add(color);
    return tag;
  }
  /**
   * @description Create the tag for a role.
   * @private
   * @param {object} role Role data to format.
   * @param {?HTMLElement} el Previous role element to update.
   * @return {HTMLElement} Created or updated element.
   */
  function makeRoleTag(role, el) {
    if (!el) {
      el = document.createElement('a');
      el.style.margin = '4px';
      el.style.borderRadius = '10px';
      el.style.padding = '2px';
      el.style.border = '1px solid black';
      try {
        el.classList.add(role.id);
      } catch (err) {
        console.error('Invalid Role ID!', err, role);
      }
    }
    el.textContent = role.name;
    if (role.color) {
      el.style.background =
          '#' + ('000000' + role.color.toString(16)).slice(-6);
      const color = role.color.toString(16);
      const r = color.substr(0, 2);
      const g = color.substr(2, 2);
      /* let b = color.substr(4, 2); */
      if (r > 'c8' && g > 'c8' /* && b > 'ee' */) {
        el.style.color = 'black';
      } else {
        el.style.color = 'white';
      }
    }
    return el;
  }
  /**
   * Create the attacker and victim information for an event.
   * @param {string} av 'Attacker' or 'Victim'.
   * @param {number} number The number of attackers or victims affected.
   * @param {string} outcome The outcomes of these players.
   * @param {{name: string, count: number}} [weapon] The weapon and number of
   * consumables used in this event.
   * @param {HTMLElement} [info] Existing element to update.
   * @return {HTMLDivElement} The element containing the info.
   */
  function makeAVInfo(av, number, outcome, weapon, info) {
    if (outcome == 'nothing') {
      outcome = 'unaffected';
    } else if (outcome == 'dies' && number != 1 && number != -1) {
      outcome = 'die';
    } else if (outcome == 'thrives' && number != 1 && number != -1) {
      outcome = 'thrive';
    } else if (outcome == 'revived' && number != 1 && number != -1) {
      outcome = 'revived';
    }

    if (!info) {
      info = document.createElement('div');
      info.classList.add('avCell');
      info.classList.add(`${av}Cell`);
    }

    let avInfo = info.getElementsByClassName('avInfoCell')[0];
    if (!avInfo) {
      avInfo = document.createElement('a');
      avInfo.classList.add('avInfoCell');
      info.appendChild(avInfo);
    }

    let count = 'No ';
    if (number < 0) {
      count = 'At least ' + number * -1;
    } else if (number > 0) {
      count = 'Exactly ' + number;
    }

    let weaponText = info.getElementsByClassName('avWeaponCell')[0];
    if (!weaponText) {
      weaponText = document.createElement('a');
      weaponText.classList.add('avWeaponCell');
      info.appendChild(weaponText);
    }
    let weaponName = info.getElementsByClassName('avWeaponNameCell')[0];
    if (!weaponName) {
      weaponName = document.createElement('a');
      weaponName.classList.add('avWeaponNameCell');
      info.appendChild(weaponName);
    }
    if (weapon && weapon.id) {
      const par = getEvent(weapon.id);
      const name = (par && par.name) || weapon.name || weapon.id;
      weaponName.setAttribute('eventId', weapon.id);
      weaponName.textContent = name;

      if (weapon.count > 0) {
        weaponText.textContent = ' and gains ' + weapon.count + ' ';
      } else {
        weaponText.textContent = ' and loses ' + (-weapon.count) + ' ';
      }
    } else {
      weaponText.textContent = '';
      weaponName.removeAttribute('eventId');
      weaponName.textContent = '';
    }

    avInfo.textContent =
        count + ' ' + av + ((Math.abs(number) == 1) ? ' ' : 's ') + outcome;

    return info;
  }
  /**
   * Request the guild member from the server if we have not already requested
   * this data.
   * @private
   * @param {string|number} memberId The ID of the user to fetch.
   * @param {string|number} [guildId] The guild to request the member from. If
   * omitted, uses the currently selected guild.
   */
  function fetchMember(memberId, guildId) {
    if (!guildId) guildId = selectedGuild;
    if (fetchMemberCount < fetchMemberMax) {
      if (!fetchedMembers[guildId]) fetchedMembers[guildId] = {};
      if (!fetchedMembers[guildId][memberId]) {
        fetchedMembers[guildId][memberId] = true;
      } else {
        return;
      }
      fetchMemberCount++;
      socket.emit('fetchMember', guildId, memberId);
    } else {
      fetchMemberRequests.push([memberId, guildId]);
    }
    if (!fetchMemberTimeout && fetchMemberRequests.length > 0) {
      fetchMemberTimeout = setTimeout(() => {
        fetchMemberCount = 0;
        fetchMemberTimeout = null;
        for (let i = 0; i < fetchMemberMax && fetchMemberRequests.length > 0;
          i++) {
          fetchMember(...fetchMemberRequests.splice(0, 1)[0]);
        }
      }, fetchMemberDelay);
    }
  }
  /**
   * Handle new data for a member received from the server.
   * @private
   * @param {string|number} guildId The ID of the guild this member is in.
   * @param {string|number} memberId The Discord User ID of this member.
   * @param {Discord~GuildMember} member The stripped member data from the
   * server.
   */
  function handleMember(guildId, memberId, member) {
    if (!members[guildId]) members[guildId] = {};
    members[guildId][memberId] = member;
    if (memberId == '124733888177111041') console.log(member);

    if ('querySelectorAll' in document) {
      const creatorInfos =
          document.querySelectorAll(`.creatorInfo[userId="${memberId}"]`);
      creatorInfos.forEach((el) => {
        el.textContent = `Creator: ${findMember(memberId).name}`;
      });
    } else {
      const creatorInfos = document.getElementsByClassName('creatorInfo');
      for (let i = 0; i < creatorInfos.length; i++) {
        if (creatorInfos[i].getAttribute('userId') !== memberId) continue;
        creatorInfos[i].textContent = `Creator: ${findMember(memberId).name}`;
      }
    }

    if (selectedGuild !== guildId) return;
    const guild = guilds[guildId];
    if (guild) {
      const statsSection = document.getElementById('statsSection');
      if (statsSection) makeStatsContainer(statsSection, guildId);
    }

    const rows = document.getElementsByClassName(memberId);
    if (!rows || rows.length == 0) return;
    for (let i = 0; i < rows.length; i++) {
      makePlayerRow(member, guild, rows[i]);
    }
    dragging.update(selectedGuild);
    if (guild && guild.members) {
      clearTimeout(updateMemberSearchTimeout);
      updateMemberSearchTimeout = setTimeout(() => {
        const data = members[selectedGuild];
        if (!data) return;
        memberFuse = new Fuse(
            guild.members.map((el) => data[el]).filter((el) => el),
            memberSearchOpts);
      }, 100);
    }

    if (!guild || !guild.hg) return;
    const left = document.getElementById('playerLeft');
    const right = document.getElementById('playerRight');
    if (right) sortMembers(right.children[1], guild.hg, false, 0, true);
    if (left) sortMembersAndTeams(left.children[1], guild.hg, true);
  }
  /**
   * Handle a guild member being added to a guild.
   * @private
   * @param {string} gId The Guild ID the member was added to.
   * @param {string} mId The Member ID of the member added.
   */
  function handleMemberAdd(gId, mId) {
    console.log('Member Added', gId, mId);
    const guild = guilds[gId];
    if (!guild) return;
    if (guild.members.find((el) => el === mId)) guild.members.push(mId);
    if (selectedGuild !== gId) return;
    fetchMember(mId, gId);
  }
  /**
   * Handle a guild member being removed from the guild.
   * @private
   * @param {string} gId The Guild ID the member was removed from.
   * @param {string} mId The Member ID of the member removed.
   */
  function handleMemberRemove(gId, mId) {
    console.log('Member Removed', gId, mId);
    const guild = guilds[gId];
    if (!guild) return;
    const index = guild.members.findIndex((el) => el === mId);
    if (index > -1) guild.members.splice(index, 1);
    if (selectedGuild !== gId) return;
    const included = guild.hg && guild.hg.currentGame &&
        guild.hg.currentGame.includedUsers.find((el) => el.id === mId);
    const inProgress =
        guild.hg && guild.hg.currentGame && guild.hg.currentGame.inProgress;
    if (included && inProgress) return;
    const list = document.getElementsByClassName(mId);
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].remove();
    }
  }
  /**
   * Handler for when the team name has been updated.
   * @private
   */
  function teamNameEditHandler() {
    socket.emit(
        'editTeam', selectedGuild, 'rename',
        this.parentNode.id.substr(4) * 1 + 1, this.value);
    // console.log(
    //     'Renaming', this.parentNode.id.substr(4) * 1 + 1, 'to', this.value);
    this.blur();
  }
  /**
   * Select a guild to show, or hide the current guild.
   * @private
   * @param {number|string} id The ID of the guild to select.
   */
  function selectGuild(id) {
    setHash('guild', id);
    hashGuild = id;
    if (selectedGuild == id) {
      unfoldedElements = document.getElementsByClassName('guildSection');
      if (unfoldedElements && unfoldedElements.length > 0) {
        unfoldedElements = [].slice.call(unfoldedElements)
            .filter((el) => !el.classList.contains('folded'))
            .map((el) => el.id);
      } else {
        unfoldedElements = [];
      }
    } else {
      unfoldedElements = [];
    }

    if (mainBody.children.length > 0) {
      mainBody.children[0].classList.add('hidden');
    }
    // if (mainBody.scrollIntoView) mainBody.scrollIntoView();
    for (let i = 0; i < guildList.children.length; i++) {
      if (typeof guildList.children[i].style === 'undefined') continue;
      if (guildList.children[i].id !== id) {
        guildList.children[i].classList.add('hidden');
      } else {
        guildList.children[i].onclick = unselectGuild;
        guildList.children[i].classList.add('selected');
      }
    }
    const guild = guilds[id];

    let guildBody = document.getElementById('guildBody');
    if (!guildBody) {
      guildBody = document.createElement('div');
      guildBody.id = 'guildBody';
      mainBody.appendChild(guildBody);
    }
    if (selectedGuild != id) {
      guildBody.innerHTML = '';
      delete fetchedMembers[selectedGuild];
    }
    selectedGuild = id;
    guildBody.classList.add('contentsection');
    guildBody.classList.add('transparentcontent');

    let refreshButton = document.getElementById('guildRefreshButton');
    if (!refreshButton) {
      refreshButton = document.createElement('a');
      refreshButton.innerHTML = 'Refresh';
      refreshButton.onclick = function() {
        eventFetching = {};
        socket.emit('fetchGames', selectedGuild);
        socket.emit('fetchRoles', selectedGuild, handleRoles);
        fetchStats(selectedGuild);
        fetchPersonalEvents();
        return false;
      };
      refreshButton.classList.add('tab');
      refreshButton.id = 'guildRefreshButton';
      guildBody.appendChild(refreshButton);
    }

    let gameName = document.getElementById('gameNameInput');
    if (!gameName) {
      gameName = document.createElement('input');
      gameName.id = 'gameNameInput';
      gameName.type = 'text';
      gameName.oninput = function() {
        this.value = this.value.slice(0, 100);
      };
      gameName.onchange = function() {
        if (this.value != guild.hg.currentGame.name) {
          console.log('Renaming game', this.value);
          this.disabled = true;
          const input = this;
          socket.emit('renameGame', selectedGuild, this.value, function(name) {
            input.disabled = false;
            console.log('Renamed game', name);
            guild.hg.currentGame.name = name;
            input.value = name;
          });
        }
        this.blur();
      };
      guildBody.insertBefore(gameName, refreshButton.nextSibling);
    }
    if (guild.hg && guild.hg.currentGame && guild.hg.currentGame.name) {
      gameName.value = guild.hg.currentGame.name;
    } else {
      gameName.value = `${guild.name}'s Hungry Games`;
    }

    let meSection = document.getElementById('userInfoSection');
    if (!meSection) meSection = document.createElement('div');
    meSection.innerHTML = '';
    meSection.classList.add('userInfoSection');
    meSection.id = 'userInfoSection';
    const myName = document.createElement('div');
    myName.style.marginBottom = 0;
    myName.style.marginTop = '1.3em';
    myName.style.fontWeight = 'bold';
    myName.appendChild(
        document.createTextNode(guild.myself.nickname || user.username));
    meSection.appendChild(myName);

    const myRoles = document.createElement('div');
    myRoles.classList.add('userRolesList');
    for (let i in guild.myself.roles) {
      if (!guild.myself.roles[i]) continue;
      let rId = guild.myself.roles[i];
      if (rId && rId.id) rId = rId.id;
      if (rId === guild.id) continue; // @everyone
      const role = roles[guild.id][rId] || {id: rId, name: rId, color: 0};

      const id = `topRole${rId}`;
      const element = document.getElementById(id);
      const myRole = makeRoleTag(role, element);
      myRole.id = id;
      myRoles.appendChild(myRole);
    }
    meSection.appendChild(myRoles);

    if (guild.ownerId == guild.myself.user.id) {
      const crown = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      crown.setAttribute('width', '24');
      crown.setAttribute('height', '24');
      crown.setAttribute('viewBox', '0 0 24 24');
      crown.style.height = '14px';
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('fill', 'none');
      g.setAttribute('fill-rule', 'evenodd');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', '#FAA61A');
      path.setAttribute('fill-rule', 'nonzero');
      path.setAttribute(
          'd',
          'M2,11 L0,0 L5.5,7 L9,0 L12.5,7 L18,0 L16,11 L2,11 L2,11 Z M16,14 C' +
              '16,14.5522847 15.5522847,15 15,15 L3,15 C2.44771525,15 2,14.55' +
              '22847 2,14 L2,13 L16,13 L16,14 Z');
      path.setAttribute('transform', 'translate(3 4)');
      g.appendChild(path);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', '24');
      rect.setAttribute('height', '24');
      g.appendChild(rect);
      crown.appendChild(g);
      myName.appendChild(crown);
    }

    if (guild.myself.premiumSinceTimestamp) {
      const boost =
          document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      boost.setAttribute('width', '18');
      boost.setAttribute('height', '18');
      boost.setAttribute('viewBox', '0 0 8 12');
      myName.appendChild(boost);
      const path =
          document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', '#ff73fa');
      path.setAttribute(
          'd', 'M4 0L0 4V8L4 12L8 8V4L4 0ZM7 7.59L4 10.59L1 7.5' +
              '9V4.41L4 1.41L7 4.41V7.59Z');
      boost.appendChild(path);
      const path2 =
          document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path2.setAttribute('fill', '#ff73fa');
      path2.setAttribute('d', 'M2 4.83V7.17L4 9.17L6 7.17V4.83L4 2.83L2 4.83Z');
      boost.appendChild(path2);
    }

    guildBody.insertBefore(meSection, gameName.nextSibling);

    let prev = meSection;
    if (!guild.hg && checkPerm(guild, null, null)) {
      let create = document.getElementById('createGameButton');
      if (!create) {
        create = document.createElement('div');
        create.id = 'createGameButton';
        const text = document.createElement('a');
        text.innerHTML = 'A game has not been created for this server, ' +
            'click here to create one.';
        text.style.cursor = 'pointer';
        text.style.textDecoration = 'underline';
        text.style.color = '#00b0f4';
        text.onclick = function() {
          socket.emit('createGame', selectedGuild);
          return false;
        };
        create.appendChild(text);
      }
      guildBody.insertBefore(create, meSection.nextSibling);
      prev = create;
    } else {
      const day = document.createElement('div');
      day.id = 'dayDisplay';
      guildBody.appendChild(day);
      updateDayNum(guild);
      prev = day;
    }

    let playerList = document.getElementById('playerList');
    if (!playerList) {
      playerList = document.createElement('div');
      playerList.id = 'playerList';
      if (!unfoldedElements.includes(playerList.id)) {
        playerList.classList.add('folded');
      }
      playerList.classList.add('guildSection');
      playerList.style.zIndex = 8;
      guildBody.insertBefore(playerList, prev.nextSibling);
    }

    let optionList = document.getElementById('optionList');
    if (!optionList) {
      optionList = document.createElement('div');
      optionList.id = 'optionList';
      if (!unfoldedElements.includes(optionList.id)) {
        optionList.classList.add('folded');
      }
      optionList.classList.add('guildSection');
      optionList.style.zIndex = 7;
      guildBody.insertBefore(optionList, playerList.nextSibling);
    }

    let actionList = document.getElementById('actionList');
    if (!actionList) {
      actionList = document.createElement('div');
      actionList.id = 'actionList';
      if (!unfoldedElements.includes(actionList.id)) {
        actionList.classList.add('folded');
      }
      actionList.classList.add('guildSection');
      actionList.style.zIndex = 6;
      guildBody.insertBefore(actionList, optionList.nextSibling);
    }

    let commandList = document.getElementById('commandList');
    if (!commandList) {
      commandList = document.createElement('div');
      commandList.id = 'commandList';
      if (!unfoldedElements.includes(commandList.id)) {
        commandList.classList.add('folded');
      }
      commandList.classList.add('guildSection');
      commandList.style.zIndex = 5;
      guildBody.insertBefore(commandList, actionList.nextSibling);
    }

    let statsList = document.getElementById('statsList');
    if (!statsList) {
      statsList = document.createElement('div');
      statsList.id = 'statsList';
      if (!unfoldedElements.includes(statsList.id)) {
        statsList.classList.add('folded');
      }
      statsList.classList.add('guildSection');
      statsList.style.zIndex = 4;
      guildBody.insertBefore(statsList, commandList.nextSibling);
    }

    let eventList = document.getElementById('eventList');
    if (!eventList) {
      eventList = document.createElement('div');
      eventList.id = 'eventList';
      if (!unfoldedElements.includes(eventList.id)) {
        eventList.classList.add('folded');
      }
      eventList.classList.add('guildSection');
      eventList.style.zIndex = 3;
      guildBody.insertBefore(eventList, statsList.nextSibling);
    }

    let dayList = document.getElementById('dayList');
    if (!dayList) {
      dayList = document.createElement('div');
      dayList.id = 'dayList';
      if (!unfoldedElements.includes(dayList.id)) {
        dayList.classList.add('folded');
      }
      dayList.classList.add('guildSection');
      dayList.style.zIndex = 2;
      guildBody.insertBefore(dayList, eventList.nextSibling);
    }

    if (!checkPerm(guild, null, null)) {
      const title = document.createElement('h4');
      title.innerHTML =
          'You do not have permission for the Hungry Games in this server. ' +
          '(You need permission for "?hg start")';
      playerList.innerHTML = '';
      playerList.appendChild(title);
    } else {
      let title = document.getElementById('playerListTitle');
      if (!title) {
        title = document.createElement('h2');
        title.innerHTML = 'Players (' + guild.members.length + ')';
        title.id = 'playerListTitle';
        title.classList.add('title');
        title.onclick = foldHandler;
        playerList.insertBefore(title, playerList.children[0]);
      }

      let playerContainer = document.getElementById('playerContainer');
      if (!playerContainer) {
        playerContainer = document.createElement('div');
        playerContainer.classList.add('section');
        playerContainer.id = 'playerContainer';
        playerList.insertBefore(playerContainer, title.nextSibling);
      }

      // LEFT COLUMN
      let playerLeft = document.getElementById('playerLeft');
      if (!playerLeft) {
        playerLeft = document.createElement('span');
        playerLeft.classList.add('playerHalf');
        playerLeft.id = 'playerLeft';
        const width = getCookie('playerListWidth');
        if (width) playerLeft.style.width = width;
        const playerListUpdate = function() {
          setCookie(
              'playerListWidth', this.style.width,
              Date.now() + 365 * 24 * 60 * 60 * 1000);
        };
        playerLeft.addEventListener('resize', playerListUpdate);
        playerLeft.addEventListener('click', playerListUpdate);
        playerLeft.addEventListener('scroll', playerListUpdate);
        playerContainer.insertBefore(playerLeft, playerContainer.children[0]);
      }

      let playerLeftButtonParent =
          document.getElementById('playerLeftButtonParent');
      if (!playerLeftButtonParent) {
        playerLeftButtonParent = document.createElement('div');
        playerLeftButtonParent.id = 'playerLeftButtonParent';
        playerLeft.insertBefore(playerLeftButtonParent, playerLeft.children[0]);
      }
      if (guild.hg) {
        playerLeftButtonParent.classList.toggle(
            'hidden', guild.hg.options.teamSize == 0);
      }

      let playerResetButton = document.getElementById('playerResetButton');
      if (!playerResetButton) {
        playerResetButton = document.createElement('a');
        playerResetButton.id = 'playerResetButton';
        playerResetButton.innerHTML = 'Reset Teams';
        playerResetButton.classList.add('tab');
        playerResetButton.classList.add('playerAllButton');
        playerResetButton.onclick = function() {
          socket.emit('resetGame', selectedGuild, 'teams', (err, res) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to reset teams.');
              return;
            }
            showMessageBox(res, 2000);
          });
          return false;
        };
        playerLeftButtonParent.insertBefore(
            playerResetButton, playerLeftButtonParent.nextSibling);
      }

      let playerRandomizeButton =
          document.getElementById('playerRandomizeButton');
      if (!playerRandomizeButton) {
        playerRandomizeButton = document.createElement('a');
        playerRandomizeButton.id = 'playerRandomizeButton';
        playerRandomizeButton.innerHTML = 'Randomize Teams';
        playerRandomizeButton.classList.add('tab');
        playerRandomizeButton.classList.add('playerAllButton');
        playerRandomizeButton.onclick = function() {
          socket.emit('editTeam', selectedGuild, 'randomize');
          return false;
        };
        playerLeftButtonParent.insertBefore(
            playerRandomizeButton, playerResetButton.nextSibling);
      }

      let leftPlayerList = document.getElementById('leftPlayerColumn');
      if (!leftPlayerList) {
        leftPlayerList = document.createElement('div');
        leftPlayerList.id = 'leftPlayerColumn';
        leftPlayerList.classList.add('playerColumn');
        leftPlayerList.classList.add('droppable');
        playerLeft.insertBefore(
            leftPlayerList, playerLeftButtonParent.nextSibling);
      }
      if (guild.members.length < 300) {
        for (let i in guild.members) {
          if (!guild.members[i]) continue;
          let member;
          if (!members[selectedGuild] ||
              !members[selectedGuild][guild.members[i]]) {
            fetchMember(guild.members[i], guild.id);
            member = {
              user: {
                id: guild.members[i],
                bot: false,
                username: guild.members[i],
              },
            };
          } else {
            member = members[selectedGuild][guild.members[i]];
          }
          const player =
              leftPlayerList.getElementsByClassName(member.user.id)[0];
          if (!player && i < 300) {
            leftPlayerList.appendChild(makePlayerRow(member, guild));
          } else if (player) {
            makePlayerRow(member, guild, player);
          }
        }
      } else if (
        guild.hg && guild.hg.currentGame &&
          guild.hg.currentGame.includedUsers) {
        const incUsers = guild.hg.currentGame.includedUsers;
        for (let i = 0; i < incUsers.length; i++) {
          let member;
          if (!members[selectedGuild] || !members[selectedGuild][incUsers[i]]) {
            fetchMember(incUsers[i].id, guild.id);
            member = {
              user: {
                id: incUsers[i].id,
                bot: false,
                username: incUsers[i].name,
              },
            };
          } else {
            member = members[selectedGuild][incUsers[i].id];
          }
          const player =
              leftPlayerList.getElementsByClassName(member.user.id)[0];
          if (!player && i < 300) {
            leftPlayerList.appendChild(makePlayerRow(member, guild));
          } else if (player) {
            makePlayerRow(member, guild, player);
          }
        }
      }

      sortMembersAndTeams(leftPlayerList, guild.hg);

      // RIGHT COLUMN
      let playerRight = document.getElementById('playerRight');
      if (!playerRight) {
        playerRight = document.createElement('span');
        playerRight.classList.add('playerHalf');
        playerRight.id = 'playerRight';
        playerContainer.insertBefore(playerRight, playerLeft.nextSibling);
      }

      let playerRightButtonParent =
          document.getElementById('playerRightButtonParent');
      if (!playerRightButtonParent) {
        playerRightButtonParent = document.createElement('div');
        playerRightButtonParent.id = 'playerRightButtonParent';
        playerRight.insertBefore(
            playerRightButtonParent, playerRight.children[0]);
      }

      let playerIncludeAllButton =
          document.getElementById('playerIncludeAllButton');
      if (!playerIncludeAllButton) {
        playerIncludeAllButton = document.createElement('a');
        playerIncludeAllButton.id = 'playerIncludeAllButton';
        playerIncludeAllButton.innerHTML = 'Include Everyone';
        playerIncludeAllButton.classList.add('tab');
        playerIncludeAllButton.classList.add('playerAllButton');
        playerIncludeAllButton.onclick = function() {
          socket.emit('includeMember', selectedGuild, 'everyone', (err) => {
            if (err) {
              console.error(err);
              // showMessageBox(err);
              return;
            }
            // socket.emit('fetchGames', selectedGuild);
          });
          return false;
        };
        playerRightButtonParent.insertBefore(
            playerIncludeAllButton, playerRightButtonParent.children[0]);
      }

      let playerExcludeAllButton =
          document.getElementById('playerExcludeAllButton');
      if (!playerExcludeAllButton) {
        playerExcludeAllButton = document.createElement('a');
        playerExcludeAllButton.id = 'playerExcludeAllButton';
        playerExcludeAllButton.innerHTML = 'Exclude Everyone';
        playerExcludeAllButton.classList.add('tab');
        playerExcludeAllButton.classList.add('playerAllButton');
        playerExcludeAllButton.onclick = function() {
          socket.emit('excludeMember', selectedGuild, 'everyone', (err) => {
            if (err) {
              console.error(err);
              // showMessageBox(err);
              return;
            }
            // socket.emit('fetchGames', selectedGuild);
          });
          return false;
        };
        playerRightButtonParent.insertBefore(
            playerExcludeAllButton, playerIncludeAllButton.nextSibling);
      }

      let createNPCButton = document.getElementById('createNPCButton');
      if (!createNPCButton) {
        createNPCButton = document.createElement('a');
        createNPCButton.id = 'createNPCButton';
        createNPCButton.innerHTML = 'Create NPC';
        createNPCButton.classList.add('tab');
        createNPCButton.classList.add('playerAllButton');
        createNPCButton.onclick = showNPCCreationView(playerContainer);
        playerRightButtonParent.insertBefore(
            createNPCButton, playerExcludeAllButton.nextSibling);
      }

      let playerRightSearchParent =
          document.getElementById('playerRightSearchParent');
      if (!playerRightSearchParent) {
        playerRightSearchParent = document.createElement('div');
        playerRightSearchParent.id = 'playerRightSearchParent';
        playerRight.insertBefore(
            playerRightSearchParent, playerRightButtonParent.nextSibling);

        const searchBar = document.createElement('input');
        searchBar.id = 'memberSearchBar';
        searchBar.type = 'text';
        searchBar.oninput = onMemberSearchChange;
        searchBar.onkeyup = function(event) {
          if (event.keyCode == 27) this.blur();
        };
        searchBar.placeholder = 'Type to search...';
        playerRightSearchParent.appendChild(searchBar);

        document.addEventListener('keydown', function(event) {
          // Already have focus.
          if (document.activeElement === searchBar) return;
          // Another input already has focus.
          if (document.activeElement.type === 'text') return;
          if (document.activeElement.type === 'number') return;

          // Check if the bar is visible.
          let el = playerRightSearchParent;
          while (el.parentNode && el.parentNode.classList) {
            if (el.parentNode.classList.contains('folded')) {
              return;
            }
            el = el.parentNode;
          }

          // Bar is visible, not already focused, and user is typing. Focus the
          // search bar.
          searchBar.focus();
        }, false);
      }

      let rightPlayerList = document.getElementById('rightPlayerColumn');
      if (!rightPlayerList) {
        rightPlayerList = document.createElement('div');
        rightPlayerList.id = 'rightPlayerColumn';
        rightPlayerList.classList.add('playerColumn');
        rightPlayerList.classList.add('droppable');
        playerRight.insertBefore(
            rightPlayerList, playerRightSearchParent.nextSibling);
      }
      for (let i in guild.members) {
        if (!guild.members[i]) continue;
        let member;
        if (!members[selectedGuild] ||
            !members[selectedGuild][guild.members[i]]) {
          fetchMember(guild.members[i], guild.id);
          member = {
            user:
                {id: guild.members[i], bot: false, username: guild.members[i]},
          };
        } else {
          member = members[selectedGuild][guild.members[i]];
        }
        const player =
            rightPlayerList.getElementsByClassName(member.user.id)[0];
        if (!player && i < 300) {
          rightPlayerList.appendChild(makePlayerRow(member, guild));
        } else if (player) {
          makePlayerRow(member, guild, player);
        }
      }
      sortMembers(rightPlayerList, guild.hg);

      if (members[selectedGuild] && guild.members) {
        const data = members[selectedGuild];
        memberFuse = new Fuse(
            guild.members
                .map((el) => {
                  return data[el];
                })
                .filter((el) => el),
            memberSearchOpts);
      }

      let playerListTutorial = document.getElementById('playerListTutorial');
      if (!playerListTutorial) {
        playerListTutorial = document.createElement('span');
        playerListTutorial.id = 'playerListTutorial';
        playerContainer.insertBefore(
            playerListTutorial, rightPlayerList.nextSibling);
      }

      let tutorialTitle = document.getElementById('playerListTutorialTitle');
      if (!tutorialTitle) {
        tutorialTitle = document.createElement('a');
        tutorialTitle.id = 'playerListTutorialTitle';
        tutorialTitle.classList.add('title');
        tutorialTitle.textContent = 'Help';
        tutorialTitle.onclick = function() {
          this.parentNode.classList.toggle('folded');
          setCookie(
              'showTutorials', !this.parentNode.classList.contains('folded'),
              Date.now() + 365 * 24 * 3600000);
        };
        playerListTutorial.classList.toggle(
            'folded', getCookie('showTutorials').toString() === 'false',
            Date.now() + 365 * 24 * 60 * 60 * 1000);
        playerListTutorial.insertBefore(
            tutorialTitle, playerListTutorial.children[0]);
      }

      let tutorialDescription =
          document.getElementById('playerListTutorialDescription');
      if (!tutorialDescription) {
        tutorialDescription = document.createElement('div');
        tutorialDescription.id = 'playerListTutorialDescription';
        tutorialDescription.classList.add('section');
        playerListTutorial.insertBefore(
            tutorialDescription, tutorialTitle.nextSibling);

        tutorialDescription.innerHTML =
            '<a>Drag players to their intended positions.<br><br>Left column ' +
            'is included players.<br>Right column is all players.<br><br>' +
            'Drag player from left to right to exclude them.</a>';
      }

      let touchInfo = document.getElementById('playerTutorialTouchInfo');
      if ('ontouchstart' in document.documentElement) {
        if (!touchInfo) {
          touchInfo = document.createElement('p');
          touchInfo.innerHTML =
              '<strong>With touch screen:</strong><br>Touch and hold to ' +
              'select,<br>then touch and hold to choose destination.';
          tutorialDescription.appendChild(touchInfo);
        }
      }

      let optionTitle = document.getElementById('optionTitle');
      if (!optionTitle) {
        optionTitle = document.createElement('h2');
        optionTitle.id = 'optionTitle';
        optionTitle.innerHTML = 'Options';
        optionTitle.classList.add('title');
        optionTitle.onclick = foldHandler;
        optionList.insertBefore(optionTitle, optionList.children[0]);
      }
      let optionSection = document.getElementById('optionSection');
      if (!optionSection) {
        optionSection = document.createElement('div');
        optionSection.id = 'optionSection';
        optionSection.classList.add('section');
        optionList.insertBefore(optionSection, optionTitle.nextSibling);
      }
      if (defaultOptions && guild.hg) {
        let resetDiv = document.getElementById('optionReset');
        if (!resetDiv) {
          resetDiv = document.createElement('div');
          resetDiv.id = 'optionReset';
          resetDiv.style.textAlign = 'right';
          const optionResetButton = document.createElement('button');
          optionResetButton.innerHTML = 'Reset all to default';
          optionResetButton.classList.add('button');
          optionResetButton.onclick = function() {
            socket.emit('resetGame', selectedGuild, 'options', (err, res) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to reset options.');
                return;
              }
              showMessageBox(res, 2000);
            });
          };
          resetDiv.appendChild(optionResetButton);
          optionSection.insertBefore(resetDiv, optionSection.children[0]);
        }
        makeOptionContainer(optionSection, guild.hg.options);
      }

      let actionTitle = document.getElementById('actionTitle');
      if (!actionTitle) {
        actionTitle = document.createElement('h2');
        actionTitle.id = 'actionTitle';
        actionTitle.innerHTML = 'Actions';
        actionTitle.classList.add('title');
        actionTitle.onclick = foldHandler;
        actionList.insertBefore(actionTitle, actionList.children[0]);

        const actionSection = document.createElement('div');
        actionSection.id = 'actionSection';
        actionSection.classList.add('section');
        actionList.appendChild(actionSection);

        makeActionContainer(actionSection, guild);
      }

      let commandTitle = document.getElementById('commandTitle');
      if (!commandTitle) {
        commandTitle = document.createElement('h2');
        commandTitle.id = 'commandTitle';
        commandTitle.innerHTML = 'Commands';
        commandTitle.classList.add('title');
        commandTitle.onclick = foldHandler;
        commandList.insertBefore(commandTitle, commandList.children[0]);

        const commandSection = document.createElement('div');
        commandSection.classList.add('section');
        commandList.appendChild(commandSection);
        for (let i in commands) {
          if (!commands[i]) continue;
          commandSection.appendChild(makeCommandRow(commands[i], guild));
        }
      }

      let statsTitle = document.getElementById('statsTitle');
      let statsSection;
      if (!statsTitle) {
        statsTitle = document.createElement('h2');
        statsTitle.id = 'statsTitle';
        statsTitle.innerHTML = 'Stats';
        statsTitle.classList.add('title');
        statsTitle.onclick = foldHandler;
        statsList.insertBefore(statsTitle, statsList.children[0]);

        statsSection = document.createElement('div');
        statsSection.id = 'statsSection';
        statsSection.classList.add('section');
        statsList.appendChild(statsSection);
      } else {
        statsSection = document.getElementById('statsSection');
      }
      makeStatsContainer(statsSection, guild.id);

      // EVENTS \\

      let eventTitle = document.getElementById('eventTitle');
      if (!eventTitle) {
        eventTitle = document.createElement('h2');
        eventTitle.id = 'eventTitle';
        eventTitle.innerHTML = 'Events';
        eventTitle.classList.add('title');
        eventTitle.onclick = foldHandler;
        eventList.insertBefore(eventTitle, eventList.children[0]);
      }

      let claimLegacyInfo = document.getElementById('claimLegacyParent');
      if (!claimLegacyInfo) {
        claimLegacyInfo = document.createElement('div');
        claimLegacyInfo.id = 'claimLegacyParent';
        claimLegacyInfo.classList.add('guildSection');
        claimLegacyInfo.classList.add('guildSubSection');
        eventList.insertBefore(claimLegacyInfo, eventTitle.nextSibling);

        const description = document.createElement('a');
        description.innerHTML =
            'Your game contains custom events in the older format and needs ' +
            'to be updated.<br><br>Claiming the events will move all custom ' +
            'events to your account, and only you will be able to edit them.' +
            '<br><br>';
        claimLegacyInfo.appendChild(description);

        const claimButton = document.createElement('button');
        claimButton.textContent = 'Claim All Legacy Events';
        claimButton.onclick = function() {
          this.disabled = true;
          socket.emit(
              'claimLegacyEvents', selectedGuild, (err, res, stringified) => {
                this.disabled = false;
                if (err) {
                  showMessageBox(err.replace(/\n/g, '<br>'), 10000, true);
                } else {
                  showMessageBox(res.replace(/\n/g, '<br>'), 10000, true);
                  const dl = document.createElement('a');
                  dl.download = 'HGLegacyEventBackup.json';
                  dl.href = 'data:application/json;charset=utf-8,' +
                      encodeURIComponent(stringified);
                  document.body.appendChild(dl);
                  dl.click();
                  dl.remove();
                  claimLegacyInfo.classList.add('hidden');
                }
              });
        };
        claimLegacyInfo.appendChild(claimButton);
      }
      const hasLegacy = guild.hg && guild.hg.legacyEvents;
      claimLegacyInfo.classList.toggle('hidden', !hasLegacy);


      // Default
      let defaultEventSubSection = document.getElementById('defaultEvents');
      if (!defaultEventSubSection) {
        defaultEventSubSection = document.createElement('div');
        defaultEventSubSection.id = 'defaultEvents';
        if (!unfoldedElements.includes(defaultEventSubSection.id)) {
          defaultEventSubSection.classList.add('folded');
        }
        defaultEventSubSection.classList.add('guildSection');
        defaultEventSubSection.classList.add('guildSubSection');
        eventList.insertBefore(
            defaultEventSubSection, claimLegacyInfo.nextSibling);
      }

      let defaultEventsTitle = document.getElementById('defaultEventsTitle');
      if (!defaultEventsTitle) {
        defaultEventsTitle = document.createElement('h3');
        defaultEventsTitle.id = 'defaultEventsTitle';
        defaultEventsTitle.innerHTML = 'Default';
        defaultEventsTitle.classList.add('title');
        defaultEventsTitle.onclick = foldHandler;
        defaultEventSubSection.insertBefore(
            defaultEventsTitle, defaultEventSubSection.children[0]);
      }

      let defaultEventsContainer =
          document.getElementById('defaultEventsContainer');
      if (!defaultEventsContainer) {
        defaultEventsContainer = document.createElement('div');
        defaultEventsContainer.classList.add('section');
        defaultEventsContainer.id = 'defaultEventsContainer';
        defaultEventSubSection.appendChild(defaultEventsContainer);
      }
      if (defaultEvents) {
        makeEventContainer(defaultEventsContainer, defaultEvents, 'default');
      }

      // Custom
      let customEventSubSection = document.getElementById('customEvents');
      if (!customEventSubSection) {
        customEventSubSection = document.createElement('div');
        customEventSubSection.id = 'customEvents';
        if (!unfoldedElements.includes(customEventSubSection.id)) {
          customEventSubSection.classList.add('folded');
        }
        customEventSubSection.classList.add('guildSection');
        customEventSubSection.classList.add('guildSubSection');
        eventList.insertBefore(
            customEventSubSection, defaultEventSubSection.nextSibling);
      }
      let customEventsTitle = document.getElementById('customEventsTitle');
      if (!customEventsTitle) {
        customEventsTitle = document.createElement('h3');
        customEventsTitle.id = 'customEventsTitle';
        customEventsTitle.innerHTML = 'Custom';
        customEventsTitle.classList.add('title');
        customEventsTitle.onclick = foldHandler;
        customEventSubSection.insertBefore(
            customEventsTitle, customEventSubSection.children[0]);
      }

      let customEventsContainer =
          document.getElementById('customEventsContainer');
      if (!customEventsContainer) {
        customEventsContainer = document.createElement('div');
        customEventsContainer.classList.add('section');
        customEventsContainer.id = 'customEventsContainer';
        customEventSubSection.insertBefore(
            customEventsContainer, customEventsTitle.nextSibling);
      }
      if (guild.hg) {
        makeEventContainer(
            customEventsContainer, guild.hg.customEventStore, 'custom');
      }

      // Create
      let createEventSubSection = document.getElementById('createEvents');
      if (!createEventSubSection) {
        createEventSubSection = document.createElement('div');
        createEventSubSection.id = 'createEvents';
        if (!unfoldedElements.includes(createEventSubSection.id)) {
          createEventSubSection.classList.add('folded');
        }
        createEventSubSection.classList.add('guildSection');
        createEventSubSection.classList.add('guildSubSection');
        eventList.insertBefore(
            createEventSubSection, customEventSubSection.nextSibling);
      }
      let createEventsTitle = document.getElementById('createEventsTitle');
      if (!createEventsTitle) {
        createEventsTitle = document.createElement('h3');
        createEventsTitle.id = 'createEventsTitle';
        createEventsTitle.innerHTML = 'Create New Events';
        createEventsTitle.classList.add('title');
        createEventsTitle.onclick = foldHandler;
        createEventSubSection.insertBefore(
            createEventsTitle, createEventSubSection.children[0]);
      }

      let createEventsContainer =
          document.getElementById('createEventsContainer');
      if (!createEventsContainer) {
        createEventsContainer = document.createElement('div');
        createEventsContainer.classList.add('section');
        createEventsContainer.id = 'createEventsContainer';
        createEventSubSection.appendChild(createEventsContainer);
      }
      makeChooseEventContainer(createEventsContainer);
    }

    let dayTitle = document.getElementById('dayTitle');
    if (!dayTitle) {
      dayTitle = document.createElement('h2');
      dayTitle.id = 'dayTitle';
      dayTitle.innerHTML = 'Current Day';
      dayTitle.classList.add('title');
      dayTitle.onclick = foldHandler;
      dayList.insertBefore(dayTitle, dayList.children[0]);
      const dayContainer = document.createElement('div');
      dayContainer.classList.add('section');
      dayContainer.id = 'dayContainer';
      dayList.insertBefore(dayContainer, dayTitle.nextSibling);
    }
    dragging.update(selectedGuild);
    updateDaySection(guild, true);
    setTimeout(function() {
      guildBody.classList.remove('hidden');
    });
  }
  /**
   * Make a container that shows a list of events of a type.
   * @private
   * @param {HTMLElement} container The container to replace.
   * @param {
   *   SpikeyBot~HungryGames~Event[]
   *   | SpikeyBot~HungryGames~ArenaEvent[]
   *   | SpikeyBot~HungryGames~WeaponEvent[]
   * } eventList The list of all events to show.
   * @param {string} pK The parent key of these events.
   */
  function makeEventContainer(container, eventList, pK) {
    for (let e in eventList) {
      if (!eventList[e]) continue;
      const evts = eventList[e];
      const list = evts.sort().reverse().map((el) => {
        return {id: el};
      });
      makeEventSection(container, e, list, pK);
    }
  }
  /**
  /**
   * Handler for when the search box has been updated.
   * @private
   */
  function onMemberSearchChange() {
    const container = document.getElementById('rightPlayerColumn');
    const guild = guilds[selectedGuild];
    let result = memberFuse.search(this.value);
    if (result.length > 0) {
      // Limit matches to first 10.
      result = result.slice(0, 10);

      for (let i = 0; i < container.children.length; i++) {
        container.children[i].classList.toggle(
            'hidden',
            !result.find((el) => el.user.id == container.children[i].id));
      }
      for (let i = 0; i < result.length; i++) {
        const match = container.getElementsByClassName(result[i].user.id)[0];
        if (match) {
          container.appendChild(match);
        } else {
          container.appendChild(makePlayerRow(result[i], guild));
        }
      }
    } else {
      for (let i = 0; i < container.children.length; i++) {
        container.children[i].classList.remove('hidden');
      }
      sortMembers(container, guild.hg);
    }
    container.dispatchEvent(new Event('scroll'));
  }
  /**
   * Make the primary container for all options.
   * @private
   * @param {HTMLElement} container The container to replace
   * @param {Object} options All of the options and values for the guild.
   */
  function makeOptionContainer(container, options) {
    if (!container) return;
    const keys = Object.keys(options);
    /* while (container.children.length > 2) {
      container.lastChild.remove();
    } */
    const catList = [];
    keys.sort((a, b) => {
      if (!defaultOptions[a]) return 1;
      if (!defaultOptions[b]) return -1;
      const ac = defaultOptions[a].category;
      const bc = defaultOptions[b].category;
      if (!catList.includes(ac)) catList.push(ac);
      if (ac === 'other') return 1;
      if (bc === 'other') return -1;

      if (ac == bc) {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      }
      if (!ac) return 1;
      if (!bc) return -1;
      if (ac < bc) return -1;
      if (ac > bc) return 1;
    });
    let prevTab = null;
    for (let i = 0; i < keys.length; i++) {
      const cat = defaultOptions[keys[i]] ?
          defaultOptions[keys[i]].category || 'other' :
          'Errored';
      let section = document.getElementById(`${cat}Options`);
      if (!section) {
        const title = document.createElement('h2');
        title.id = `optionsCatTitle${cat}`;
        title.title = cat;
        title.classList.add('title');
        title.classList.add('folded');
        title.classList.add('optionsCategoryTitle');
        title.style.width = Math.floor(1 / catList.length * 100 - 1) + '%';
        title.onclick = function() {
          const cat =
              this.classList.contains('folded') ? this.title : 'NOTHING';

          const sections = container.getElementsByClassName('section');
          for (const l of sections) {
            l.classList.toggle('folded', l.id !== `${cat}Options`);
          }
          const titles = container.getElementsByClassName('title');
          for (const l of titles) {
            l.classList.toggle(
                'folded', l.id !== `optionsCatTitle${cat}`);
          }
        };
        title.appendChild(document.createTextNode(camelToSpaces(cat)));
        container.insertBefore(title, prevTab && prevTab.nextSibling);
        prevTab = title;

        section = document.createElement('div');
        section.id = `${cat}Options`;
        section.classList.add('section');
        section.classList.add('folded');
        section.classList.add('optionsCategorySection');
        container.appendChild(section);
      }
      let row = document.getElementById(keys[i]);
      if (!row) {
        row = makeOptionRow(keys[i], options[keys[i]]);
      } else {
        const newRow = makeOptionRow(keys[i], options[keys[i]]);
        section.replaceChild(newRow, row);
        row = newRow;
      }
      row.style.zIndex = keys.length - i;
      section.appendChild(row);
    }
  }
  /**
   * Make the primary container for stats and leaderboard.
   * @private
   * @param {HTMLElement} container The container to replace
   * @param {string} gId ID of the guild to show stats for.
   */
  function makeStatsContainer(container, gId) {
    const groups = statGroups[gId];
    let groupSection = document.getElementById('statGroupListSection');
    if (!groupSection) {
      const groupList = document.createElement('div');
      groupList.id = 'statGroupListContainer';
      container.appendChild(groupList);

      const title = document.createElement('h3');
      title.innerHTML = 'Stat Groups';
      title.id = 'statGroupListTitle';
      groupList.appendChild(title);

      groupSection = document.createElement('div');
      groupSection.id = 'statGroupListSection';
      groupList.appendChild(groupSection);
    }

    if (!groups) return;
    const game = guilds[selectedGuild] && guilds[selectedGuild].hg;
    if (!game) return;
    const selected = game.statGroup;
    const empty = !selected || !groups[selected] || !groups[selected].list ||
        Object.keys(groups[selected].list).length === 0;

    for (const child of groupSection.children) {
      const id = child.id.match(/^statGroup(.+)$/);
      if (id && !groups[id[1]]) {
        child.remove();
      }
    }

    const list = Object.values(groups);
    for (const g of list) {
      const id = `statGroup${g.id}`;
      let row = document.getElementById(id);
      if (!row) {
        row = document.createElement('div');
        row.style.minHeight = '25px';
        row.id = id;
        if (g.id === 'global') {
          row.textContent = 'Lifetime';
        } else if (g.id === 'previous') {
          row.textContent = 'Previous Game';
        } else {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = g.id;
          checkbox.id = `${id}Checkbox`;
          checkbox.name = 'statGroupRadio';
          checkbox.onchange = function() {
            const value = this.checked ? this.value : null;
            socket.emit('selectStatGroup', selectedGuild, value, (err) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to select group: ' + err);
                return;
              }
              console.log('SelectGroup:', value);
              game.statGroup = value;
              makeStatsContainer(container, gId);
            });
          };
          row.appendChild(checkbox);
          const label = document.createElement('label');
          label.htmlFor = checkbox.name;
          row.appendChild(label);
          if (g.meta && g.meta.name) {
            label.textContent = `${g.id}: ${g.meta.name}`;
          } else {
            label.textContent = g.id;
          }
          const deleteButton = document.createElement('button');
          deleteButton.textContent = '-';
          deleteButton.style.float = 'right';
          deleteButton.title = `Delete ${g.id}`;
          const groupId = g.id;
          deleteButton.onclick = function() {
            console.log('Delete Group', groupId);
            socket.emit('deleteStatGroup', selectedGuild, groupId, (err) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to delete group: ' + err);
                return;
              }
              if (game.statGroup == groupId) game.statGroup = null;
              delete groups[groupId];
              makeStatsContainer(container, gId);
            });
          };
          row.appendChild(deleteButton);
        }
        groupSection.appendChild(row);
      }
      const checkbox = document.getElementById(`${id}Checkbox`);
      if (checkbox) checkbox.checked = selected === g.id;
      if (selected === g.id || g.id === 'global' || g.id == 'previous') {
        makeStatsGroupContainer(container, g);
      }
    }
    let addGroupRow = document.getElementById('createStatGroupRow');
    if (!addGroupRow) {
      addGroupRow = document.createElement('div');
      addGroupRow.id = 'createStatGroupRow';

      const button = document.createElement('button');
      button.textContent = '+';
      button.title = 'Create Group';
      button.onclick = function() {
        const gId = selectedGuild;
        name.disabled = true;
        button.disabled = true;
        socket.emit(
            'createStatGroup', gId, name.value, (err, groupId, meta) => {
              name.disabled = false;
              button.disabled = false;
              if (err) {
                console.error(err);
                showMessageBox('Failed to create group: ' + err);
                return;
              }
              name.value = '';
              if (!statGroups[gId][groupId]) statGroups[gId][groupId] = {};
              statGroups[gId][groupId].id = groupId;
              statGroups[gId][groupId].meta = meta;
              game.statGroup = groupId;
              console.log('StatGroup', gId, groupId, meta);
              const container = document.getElementById('statsSection');
              if (container) makeStatsContainer(container, gId);
            });
      };
      const name = document.createElement('input');
      name.type = 'text';
      name.placeholder = 'New group';
      name.oninput = function() {
        if (this.value.length > 24) this.value = this.value.substring(0, 24);
      };
      name.onkeyup = function(event) {
        if (event.keyCode == 13) {
          this.blur();
          button.onclick();
        } else if (event.keyCode == 27) {
          this.blur();
        }
      };

      addGroupRow.appendChild(name);
      addGroupRow.appendChild(button);
    }
    groupSection.appendChild(addGroupRow);
    if (empty) {
      const box = document.getElementById('statGroupBoxcustom');
      if (box) {
        if (!selected) {
          box.remove();
        } else {
          const old = box.getElementsByClassName('statGroupLeaderboard')[0];
          if (old) old.remove();
        }
      }
    }
  }

  /**
   * Make a container for a single stat group to show the top players for the
   * selected stat.
   * @private
   * @param {HTMLElement} container The container to add this group to.
   * @param {Object} group The group data currently available.
   */
  function makeStatsGroupContainer(container, group) {
    let id = group.id;
    if (id !== 'previous' && id !== 'global') id = 'custom';
    id = `statGroupBox${id}`;
    let box = document.getElementById(id);
    if (!box) {
      box = document.createElement('div');
      box.id = id;
      box.classList.add('statGroupBox');
      container.appendChild(box);
    }
    let title = box.getElementsByClassName('statTitle')[0];
    if (!title) {
      title = document.createElement('h3');
      title.classList.add('statTitle');
      box.appendChild(title);
    }
    if (group.meta && group.meta.name) {
      title.textContent = `${group.id}: ${group.meta.name}`;
    } else if (group.id === 'previous') {
      title.textContent = `Previous Game`;
    } else if (group.id === 'global') {
      title.textContent = `Lifetime`;
    } else {
      title.textContent = group.id;
    }

    let leaderboard = box.getElementsByClassName('statGroupLeaderboard')[0];
    if (!leaderboard) {
      leaderboard = document.createElement('div');
      leaderboard.classList.add('statGroupLeaderboard');
      box.appendChild(leaderboard);
    }

    let statSelect = box.getElementsByClassName('statGroupSelect')[0];
    if (!statSelect) {
      statSelect = document.createElement('select');
      statSelect.classList.add('statGroupSelect');
      statSelect.onchange = function() {
        makeStatsGroupContainer(container, group);
      };
      box.insertBefore(statSelect, leaderboard);
    }

    if (!group.list) {
      fetchLeaderboard(selectedGuild, group.id);
      return;
    }

    const cols = Object.values(group.list)[0];
    for (const opt in cols) {
      if (opt === 'id') continue;
      let option = document.getElementById(`${id}${opt}`);
      if (!option) {
        option = document.createElement('option');
        option.id = `${id}${opt}`;
        option.value = opt;
        statSelect.add(option);
      }
      option.textContent = camelToSpaces(opt);
    }

    const pL = 25; // Page length.

    if (!group.page || group.page < 0) group.page = 0;
    const page = group.page;
    fetchLeaderboard(selectedGuild, group.id, statSelect.value, page * pL);
    if (!group[statSelect.value]) return;

    const list = group[statSelect.value];
    if (!list[page * pL]) {
      if (group.page === 0) return;
      group.page--;
      makeStatsGroupContainer(container, group);
      return;
    }
    for (let i = 0; i < pL; i++) {
      const rowId = `${id}Row${i}`;
      let row = document.getElementById(rowId);
      if (!row) {
        row = document.createElement('div');
        row.classList.add('statGroupRow');
        row.id = rowId;
        leaderboard.appendChild(row);
      }
      const index = page * pL + i;
      if (!list[index]) {
        row.textContent = `${index+1})`;
        continue;
      }
      row.style.fontWeight = list[index].id === user.id ? 'bold' : '';
      const player = findMember(list[index].id);
      if (player.name === list[index].id) {
        fetchMember(list[index].id, selectedGuild);
      }
      const stat = list[index][statSelect.value];
      row.textContent = `${index+1}) ${stat}. ${player.name}`;
    }
    let pageControl = box.getElementsByClassName('pageControl')[0];
    let pageNums;
    if (!pageControl) {
      pageControl = document.createElement('div');
      pageControl.classList.add('pageControl');

      const prevButton = document.createElement('button');
      prevButton.innerHTML = '<';
      prevButton.onclick = function() {
        if (group.page == 0) return;
        group.page--;
        makeStatsGroupContainer(container, group);
      };
      pageControl.appendChild(prevButton);

      pageNums = document.createElement('a');
      pageNums.classList.add('pageNums');
      pageControl.appendChild(pageNums);

      const nextButton = document.createElement('button');
      nextButton.innerHTML = '>';
      nextButton.onclick = function() {
        group.page++;
        makeStatsGroupContainer(container, group);
      };
      pageControl.appendChild(nextButton);
    } else {
      pageNums = pageControl.getElementsByClassName('pageNums')[0];
    }
    box.appendChild(pageControl);
    pageNums.textContent = ` ${page+1} `;
  }

  /**
   * Fetch player data for a certain group.
   * @private
   * @param {string} guildId The ID of the guild to fetch data for.
   * @param {string} groupId ID of the group to fetch data for.
   * @param {string} [stats='kills'] The name of the stat to sort by.
   * @param {number} [offset=0] Offset to start fetching players from.
   */
  function fetchLeaderboard(guildId, groupId, stats = 'kills', offset = 0) {
    if (!groupId) return;
    if (!stats) stats = 'kills';

    const now = Date.now();
    const id = `${guildId}${groupId}${offset}${stats}`;
    if (now - fetchingLeaderboard[id] < 30000) return;
    fetchingLeaderboard[id] = now;

    const pL = 26;
    const opt = {offset: offset, sort: stats, limit: pL};
    socket.emit('fetchLeaderboard', guildId, groupId, opt, (err, data) => {
      if (err) {
        console.error(
            'Failed to fetch leaderboard data', guildId, groupId, stats, offset,
            err);
        return;
      }
      let group = statGroups[guildId][groupId];
      if (!group) {
        group = statGroups[guildId][groupId] = {list: {}, [stats]: []};
      } else if (!group[stats]) {
        group[stats] = [];
      }
      if (!group.list) group.list = {};
      group[stats].splice(offset, pL, ...data);
      for (const d of data) {
        group.list[d.id] = d;
      }
      console.log('Group Updated', group);
      const container = document.getElementById('statsSection');
      if (container) makeStatsGroupContainer(container, group);
    });
  }
  /**
   * Handle a section being requested to change folding, and fold all siblings.
   * @private
   */
  function foldHandler() {
    const set = this.parentNode.classList.contains('folded');
    for (let i in this.parentNode.parentNode.children) {
      if (this.parentNode.parentNode.children[i].classList) {
        this.parentNode.parentNode.children[i].classList.add('folded');
      }
    }
    this.parentNode.classList.toggle('folded', !set);
    updateDaySectionStickyScroll();
  }
  /**
   * Handle a section being requested to change folding, but don't fold
   * siblings.
   * @private
   */
  function soloFoldHandler() {
    this.parentNode.classList.toggle('folded');
  }
  /**
   * Force no guilds selected.
   * @private
   */
  function unselectGuild() {
    selectedGuild = null;
    setHash('guild');
    mainBody.children[0].classList.remove('hidden');
    if (mainBody.children[2]) mainBody.children[2].classList.add('hidden');
    for (let i in guildList.children) {
      if (typeof guildList.children[i].style === 'undefined') continue;
      guildList.children[i].classList.remove('hidden');
      guildList.children[i].classList.remove('selected');
      guildList.children[i].onclick = function() {
        selectGuild(this.id);
      };
    }
  }
  /**
   * Listener for the checkbox being changed in the player inclusion list.
   * @private
   * @param {Event} event The event fired.
   */
  function memberCheckBoxHandler(event) {
    const guildId = selectedGuild;
    if (this.checked) {
      console.log('Including', this.value);
      socket.emit('includeMember', guildId, this.value, (err) => {
        if (err) {
          console.error(err);
          // showMessageBox(err);
          return;
        }
        // socket.emit('fetchGames', guildId);
      });
    } else {
      console.log('Excluding', this.value);
      socket.emit('excludeMember', guildId, this.value, (err) => {
        if (err) {
          console.error(err);
          // showMessageBox(err);
          return;
        }
        // socket.emit('fetchGames', guildId);
      });
    }
  }
  /**
   * Listener for the options checkbox being changed.
   * @private
   * @param {Event} event The event fired.
   */
  function optionCheckBoxHandler(event) {
    // console.log('Check', event.target.value, event.target.checked);
    const gId = selectedGuild;
    const name = event.target.value;
    socket.emit(
        'toggleOption', gId, name, event.target.checked, null,
        (err, res, value) => {
          if (err) {
            console.error(err);
            showMessageBox('Failed to change setting value.');
            return;
          }
          showMessageBox(res, 2000);
        });
  }
  /**
   * Listener for the option being submitted.
   * @private
   * @param {Event} event Click event.
   * @fires toggleOption
   */
  function optionSubmitHandler(event) {
    // console.log(
    //     'Submit', event.target.name,
    //     document.getElementById(event.target.name).value);
    const gId = selectedGuild;
    const name = event.target.name;
    const val = document.getElementById(event.target.name + 'input').value;
    socket.emit('toggleOption', gId, name, val, null, (err, res, value) => {
      if (err) {
        console.error(err);
        showMessageBox('Failed to change setting value.');
        return;
      }
      showMessageBox(res, 2000);
    });
  }
  /**
   * Listens for the option of an object type being submitted.
   * @private
   * @param {Event} event Click event.
   */
  function optionObjectSubmitHandler(event) {
    const parent = document.getElementById(event.target.name);
    const sliders = parent.getElementsByTagName('input');
    const guild = guilds[selectedGuild];
    for (let i = 0; i < sliders.length; i++) {
      let val = sliders[i].value * 1;
      if (i > 0 && sliders[i].type == 'range') {
        val -= sliders[i - 1].value * 1 + 1;
      }
      if (typeof defaultOptions[event.target.name].value[sliders[i].name] ===
          'undefined') {
        continue;
      }
      if (guild.hg.options[event.target.name][sliders[i].name] == val) {
        continue;
      }
      const gId = selectedGuild;
      const name = event.target.name;
      socket.emit(
          'toggleOption', gId, name, sliders[i].name,
          `${event.target.name} ${sliders[i].name} ${val}`,
          (err, res, value) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to change setting value.');
              return;
            }
            showMessageBox(res, 2000);
          });
    }
  }
  /**
   * Handler for option dropdown being changed.
   * @private
   * @param {Event} event The change event.
   */
  function optionSelectHandler(event) {
    // console.log('Select', event.target.id, event.target.value);
    const gId = selectedGuild;
    const name = event.target.id;
    socket.emit(
        'toggleOption', gId, name, event.target.value, null,
        (err, res, value) => {
          if (err) {
            console.error(err);
            showMessageBox('Failed to change setting value.');
            return;
          }
          showMessageBox(res, 2000);
        });
  }
  /**
   * Handler for command firing.
   * @private
   * @param {Event} event Click event.
   */
  function commandSubmitHandler(event) {
    const children = event.target.parentNode.children;
    const args = [event.target.name.replace('command', '')];
    for (let i in children) {
      if (children[i].id && children[i].id.match(/^command.*#[0-9]+$/)) {
        args.push(children[i].value);
      }
    }

    // console.log('Submit:', args);
    socket.emit(...args);

    if (args[0] === 'nextDay' || args[0] === 'startAutoplay') {
      document.getElementById('dayList').firstChild.onclick();
    }
  }
  /**
   * Handler a new message received from the server to show to the user.
   * @private
   * @param {string} text The text to show to the user.
   */
  function handleMessage(text) {
    showMessageBox(text.replace(/\n/g, '<br>'));
  }
  /**
   * Add new message to queue of message boxes.
   * @public
   * @param {string} message The message to show to the user. HTML is NOT
   * escaped and the message will be used as the innerHTML of an element.
   * @param {number} [time=7000] Number of milliseconds to show the message.
   * @param {boolean} [urgent=false] Cancel the previous message box in order to
   * show this one. False will wait until the previous message is done before
   * showing this one.
   */
  window.showMessageBox = function(message, time = 7000, urgent = false) {
    if (!messageBoxDom) return;
    // console.log('New Message:', message, time, urgent);
    if (message == messageBoxDom.innerHTML || message == '') {
      return;
    }
    for (let i = 0; i < messageBoxQueue.length; i++) {
      if (messageBoxQueue[i].message == message) {
        clearTimeout(messageBoxTimeout);
        clearTimeout(messageBoxClearTimeout);
        messageBoxTimeout = setTimeout(hideMessageBox, time);
        return;
      }
    }
    if (urgent) hideMessageBox();
    messageBoxQueue.push({message: message, time: time});
    checkMessageBox();
  };
  /**
   * Check if a message box is currently open and change it to the next message
   * if it is gone.
   * @private
   */
  function checkMessageBox() {
    if (!messageBoxDom) return;
    if (messageBoxDom.innerHTML == '' && messageBoxQueue.length > 0) {
      messageBoxDom.innerHTML = messageBoxQueue[0].message;
      messageBoxWrapperDom.classList.add('visible');
      clearTimeout(messageBoxTimeout);
      clearTimeout(messageBoxClearTimeout);
      messageBoxTimeout = setTimeout(hideMessageBox, messageBoxQueue[0].time);
      messageBoxQueue.splice(0, 1);
    }
  }
  /**
   * Hide currently open message box.
   * @public
   * @param {Event} event DOM click event.
   * @return {boolean} Always false.
   */
  window.hideMessageBox = function(event) {
    if (event) event.preventDefault();
    clearTimeout(messageBoxTimeout);
    messageBoxWrapperDom.classList.remove('visible');
    clearTimeout(messageBoxClearTimeout);
    messageBoxClearTimeout = setTimeout(clearMessageBox, 500);
    return false;
  };
  /**
   * Reset message box text in preparation for next message.
   * @private
   */
  function clearMessageBox() {
    if (!messageBoxDom) return;
    clearTimeout(messageBoxClearTimeout);
    messageBoxDom.innerHTML = '';
    checkMessageBox();
  }
  /**
   * Handle receiving new roles.
   * @private
   * @param {?string} err Possible error.
   * @param {Array.<object>} list List of roles.
   */
  function handleRoles(err, list) {
    if (err) {
      console.error('Failed to fetch roles', err);
      return;
    }
    console.log('Roles', list);

    const reset = {};
    for (const role of list) {
      if (!reset[role.guild]) {
        reset[role.guild] = true;
        roles[role.guild] = {};
      }
      roles[role.guild][role.id] = role;
      const elements = document.getElementsByClassName(role.id);
      for (const el of elements) {
        makeRoleTag(role, el);
      }
    }

    const guild = guilds[selectedGuild];
    const actionSection = document.getElementById('actionSection');
    if (guild && actionSection) makeActionContainer(actionSection, guild);
  }
  /**
   * Handle the day of a game being updated.
   * @private
   * @param {string|number} gId The gulid ID of the day update.
   * @param {Object} day The day information.
   * @param {Object} incUsers The current users included in the game.
   */
  function handleDay(gId, day, incUsers) {
    if (selectedGuild != gId) return;
    if (!day || day.num < 0) return;
    // console.log('New Day!', gId, day);
    const guild = guilds[gId];
    if (!guild.hg) {
      guild.hg = {
        currentGame: {day: day, includedUsers: incUsers, inProgress: true},
      };
    } else {
      guild.hg.currentGame.day = day;
      guild.hg.currentGame.includedUsers = incUsers;
    }
    updateDayNum(guild);
    updateDaySection(guild, true);
    updateStatusIcons(
        guild, day.num == 0 || !document.getElementById('dayStatusIcons'));
  }
  /**
   * Handle the state of the current day changing.
   * @private
   * @param {string|number} gId The ID of the guild this update is for.
   * @param {number} num The day number.
   * @param {number} state The state of the current day number.
   * @param {number} eventState The event state of an event with sub-events.
   */
  function handleDayState(gId, num, state, eventState) {
    if (selectedGuild != gId) return;
    const guild = guilds[gId];
    if (!guild.hg || guild.hg.currentGame.day.num != num) {
      socket.emit('fetchDay', selectedGuild);
    }
    if (guild.hg) {
      const updateSection = num == guild.hg.currentGame.day.num;
      guild.hg.currentGame.day.num = num;
      guild.hg.currentGame.day.state = state;
      if (state > 1 && guild.hg.currentGame.day.events &&
          guild.hg.currentGame.day.events[state - 2]) {
        guild.hg.currentGame.day.events[state - 2].state = eventState;
      }
      if (updateSection) updateDaySection(guild, false);
    }
    updateDayNum(guild);
  }
  /**
   * Update the day status at the top of the guild information.
   * @private
   * @param {Object} guild The guild object of the guild to update.
   */
  function updateDayNum(guild) {
    const day = document.getElementById('dayDisplay');
    if (!day) return;
    day.innerHTML = '';

    const text = document.createElement('a');
    if (!guild.hg || !guild.hg.currentGame.inProgress) {
      text.innerHTML = 'No game in progress';
    } else if (guild.hg.currentGame.day.state == 0) {
      text.innerHTML = '';
    } else {
      const dayPart = (guild.hg.currentGame.day.state - 1) + '/' +
          (guild.hg.currentGame.day.events.length + 1);
      const dayText = guild.hg.currentGame.day.num == 0 ?
          'in bloodbath' :
          ('Day #' + guild.hg.currentGame.day.num);
      text.appendChild(
          document.createTextNode(
              'Currently ' + dayText + ' (' + dayPart + ')'));
    }
    day.appendChild(text);
  }
  /**
   * Update the day preview of the game.
   * @private
   * @param {Object} guild The guild of which to update the game data.
   * @param {boolean} [reset=false] Whether to completely refresh the UI, or
   * just to update what's there already.
   */
  function updateDaySection(guild, reset) {
    const container = document.getElementById('dayContainer');
    if (!container) return;

    let leftSide = document.getElementById('currentDayLeftControls');
    let hideFutureCheckbox = document.getElementById('hideFutureCheckbox');
    if (!leftSide) {
      leftSide = document.createElement('div');
      leftSide.id = 'currentDayLeftControls';
    }
    if (!hideFutureCheckbox) {
      hideFutureCheckbox = document.createElement('input');
      leftSide.appendChild(hideFutureCheckbox);
      hideFutureCheckbox.type = 'checkbox';
      hideFutureCheckbox.id = 'hideFutureCheckbox';
      hideFutureCheckbox.checked = getCookie('hideFuture') === 'true';
      hideFutureCheckbox.onchange = function() {
        setCookie(
            'hideFuture', this.checked, Date.now() + 365 * 24 * 60 * 60 * 1000);
        updateDaySection(guild, false);
      };

      let hideFutureLabel = document.createElement('label');
      leftSide.appendChild(hideFutureLabel);
      hideFutureLabel.htmlFor = hideFutureCheckbox.id;
      hideFutureLabel.textContent = 'Hide future';
    }
    if (!checkPerm(guild, null, null)) {
      leftSide.style.display = 'hidden';
      hideFutureCheckbox.checked = true;
      hideFutureCheckbox.onchange = undefined;
    }
    const numEvents = document.getElementsByClassName('dayEventRow').length;
    let buttonsRow = null;
    if (!guild.hg || !guild.hg.currentGame.day.events ||
        guild.hg.currentGame.day.events.length == 0 ||
        guild.hg.currentGame.day.state === 0 || guild.hg.currentGame.ended) {
      container.innerHTML = '';

      buttonsRow = document.createElement('div');
      buttonsRow.id = 'dayControlRow';
      buttonsRow.style.textAlign = 'right';

      buttonsRow.appendChild(leftSide);

      let channelSelect = document.createElement('select');
      if (guild.hg) channelSelect.value = guild.hg.outputChannel;
      for (let i = 0; i < guild.channels.length; i++) {
        let channelOpt = document.createElement('option');
        channelOpt.classList.add(guild.channels[i].id);
        channelOpt.value = guild.channels[i].id;
        let channel = channels[guild.channels[i].id];
        if (channel) {
          channelOpt.disabled = channel.type != 'text';
          channelOpt.innerHTML = channel.name;
          if (channel.type === 'category') {
            channelOpt.innerHTML = channel.name;
            channelOpt.style.background = 'darkgrey';
            channelOpt.style.fontWeight = 'bolder';
          } else if (channel.type === 'voice') {
            channelOpt.innerHTML = '&#128266; ' + channelOpt.innerHTML;
            channelOpt.style.background = 'lightgrey';
          } else {
            channelOpt.innerHTML = '&#65283;' + channelOpt.innerHTML;
            if (i > 0 && channelSelect.children[channelSelect.selectedIndex] &&
                channelSelect.children[channelSelect.selectedIndex].disabled) {
              channelSelect.value = channel.id;
            }
          }
        } else {
          channelOpt.innerHTML = guild.channels[i].id;
        }
        channelSelect.appendChild(channelOpt);
      }
      sortChannelOptions(channelSelect);
      if (guild.hg && guild.hg.outputChannel) {
        const sI = channelSelect.selectedIndex;
        channelSelect.value = guild.hg.outputChannel;
        if (sI > 0 && channelSelect.children[sI].disabled) {
          channelSelect.selectedIndex = sI;
        }
      }
      buttonsRow.appendChild(channelSelect);

      if (guild.hg && guild.hg.currentGame && guild.hg.currentGame.inProgress) {
        let endGameButton = document.createElement('button');
        endGameButton.innerHTML = 'Abort Game';
        endGameButton.classList.add('tab');
        endGameButton.classList.add('currentDayControls');
        endGameButton.onclick = function() {
          socket.emit('endGame', selectedGuild, (err, game) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to end game.');
              return;
            }
            showMessageBox('Game ended.');
            if (game) handleGame(game.id, game);
          });
        };
        buttonsRow.appendChild(endGameButton);

        let nextDayButton = document.createElement('button');
        nextDayButton.innerHTML = 'Next Day';
        nextDayButton.classList.add('tab');
        nextDayButton.classList.add('currentDayControls');
        nextDayButton.onclick = function() {
          socket.emit('nextDay', selectedGuild, channelSelect.value, (err) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to start day.');
              return;
            }
            showMessageBox('Starting next day.');
          });
        };
        buttonsRow.appendChild(nextDayButton);

        let stepGameButton = document.createElement('button');
        stepGameButton.innerHTML = 'Step Game';
        stepGameButton.classList.add('tab');
        stepGameButton.classList.add('currentDayControls');
        stepGameButton.onclick = function() {
          socket.emit('gameStep', selectedGuild, channelSelect.value, (err) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to step day.');
              return;
            }
          });
        };
        buttonsRow.appendChild(stepGameButton);
      } else {
        let startGameButton = document.createElement('button');
        startGameButton.innerHTML = 'Start Game';
        startGameButton.classList.add('tab');
        startGameButton.classList.add('currentDayControls');
        startGameButton.onclick = function() {
          socket.emit(
              'startGame', selectedGuild, channelSelect.value, (err) => {
                if (err) {
                  console.error(err);
                  showMessageBox('Failed to start game.');
                  return;
                }
                showMessageBox('Started game.');
              });
        };
        buttonsRow.appendChild(startGameButton);
      }

      let enableAutoplayButton = document.createElement('button');
      enableAutoplayButton.innerHTML = 'Autoplay';
      enableAutoplayButton.classList.add('tab');
      enableAutoplayButton.classList.add('currentDayControls');
      enableAutoplayButton.onclick = function() {
        socket.emit(
            'startAutoplay', selectedGuild, channelSelect.value,
            (err) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to enable autoplay.');
                return;
              }
              showMessageBox('Enabled autoplay.');
            });
      };
      buttonsRow.appendChild(enableAutoplayButton);

      container.appendChild(buttonsRow);

      container.appendChild(
          document.createTextNode('No day is currently in progress'));
    } else if (reset || numEvents !== guild.hg.currentGame.day.events.length) {
      container.innerHTML = '';

      buttonsRow = document.createElement('div');
      buttonsRow.id = 'dayControlRow';
      buttonsRow.style.textAlign = 'right';

      buttonsRow.appendChild(leftSide);

      let pauseDayButton = document.createElement('button');
      pauseDayButton.innerHTML = 'Pause';
      pauseDayButton.classList.add('tab');
      pauseDayButton.classList.add('currentDayControls');
      pauseDayButton.onclick = function() {
        socket.emit('pauseGame', selectedGuild, (err) => {
          if (err) {
            console.error(err);
            showMessageBox('Failed to pause ');
            return;
          }
          showMessageBox('Paused Game');
        });
      };
      buttonsRow.appendChild(pauseDayButton);

      let nextDayButton = document.createElement('button');
      nextDayButton.innerHTML = 'Next Day / Resume';
      nextDayButton.classList.add('tab');
      nextDayButton.classList.add('currentDayControls');
      nextDayButton.onclick = function() {
        const channel = guild.hg.outputChannel;
        socket.emit('nextDay', selectedGuild, channel, (err) => {
          if (err) {
            console.error(err);
            showMessageBox('Failed to start day.');
            return;
          }
          showMessageBox('Starting next day.');
        });
      };
      buttonsRow.appendChild(nextDayButton);

      let stepGameButton = document.createElement('button');
      stepGameButton.innerHTML = 'Step';
      stepGameButton.classList.add('tab');
      stepGameButton.classList.add('currentDayControls');
      stepGameButton.onclick = function() {
        const channel = guild.hg.outputChannel;
        socket.emit('gameStep', selectedGuild, channel, (err) => {
          if (err) {
            console.error(err);
            showMessageBox('Failed to step day.');
            return;
          }
        });
      };
      buttonsRow.appendChild(stepGameButton);

      let endGameButton = document.createElement('button');
      endGameButton.innerHTML = 'Abort Game';
      endGameButton.classList.add('tab');
      endGameButton.classList.add('currentDayControls');
      endGameButton.onclick = function() {
        socket.emit('endGame', selectedGuild,
            (err, game) => {
              if (err) {
                console.error(err);
                showMessageBox('Failed to end game.');
                return;
              }
              showMessageBox('Game ended.');
              if (game) handleGame(game.id, game);
            });
      };
      buttonsRow.appendChild(endGameButton);

      if (guild.hg.autoPlay) {
        let pauseAutoplayButton = document.createElement('button');
        pauseAutoplayButton.innerHTML = 'Pause Autoplay';
        pauseAutoplayButton.classList.add('tab');
        pauseAutoplayButton.classList.add('currentDayControls');
        pauseAutoplayButton.onclick = function() {
          socket.emit('pauseAutoplay', selectedGuild, (err) => {
            if (err) {
              console.error(err);
              showMessageBox('Failed to pause autoplay: ' + err);
              return;
            }
            showMessageBox('Paused autoplay.');
          });
        };
        buttonsRow.appendChild(pauseAutoplayButton);
      } else {
        let startAutoplayButton = document.createElement('button');
        startAutoplayButton.innerHTML = 'Autoplay';
        startAutoplayButton.classList.add('tab');
        startAutoplayButton.classList.add('currentDayControls');
        startAutoplayButton.onclick = function() {
          socket.emit(
              'startAutoplay', selectedGuild, guild.hg.outputChannel, (err) => {
                if (err) {
                  console.error(err);
                  showMessageBox('Failed to enable autoplay.');
                  return;
                }
                showMessageBox('Enabled autoplay.');
              });
        };
        buttonsRow.appendChild(startAutoplayButton);
      }

      container.appendChild(buttonsRow);

      let list = guild.hg.currentGame.day.events;
      let state = guild.hg.currentGame.day.state;
      for (let i in list) {
        if (!list[i]) continue;
        container.appendChild(makeDayEventRow(list[i], i, state - 2));
      }
    }
    if (buttonsRow) {
      const filler = document.createElement('div');
      filler.id = 'dayControlRowFiller';
      container.insertBefore(filler, buttonsRow.nextSibling);
    }

    const day = guild.hg && guild.hg.currentGame && guild.hg.currentGame.day;
    if (day) {
      let list = day.events;
      for (let i in list) {
        if (!list[i]) continue;
        let row = document.getElementById(`dayEvent${i}`);
        if (!row) continue;

        const current = day.state - 2 == i;

        if (list[i].battle) {
          makeDayEventRow(list[i], i, day.state - 2);
        }

        const hide =
            (hideFutureCheckbox.checked &&
             (day.state - 2 < i || (list[i].battle && current &&
                                    list[i].state < list[i].attacks.length))) ||
            false;
        row.classList.toggle('future', hide);
        row.classList.toggle('current', current);
        row.classList.toggle('previous', day.state - 2 > i);
      }
    }

    let statusIcons = document.getElementById('dayStatusIcons');
    if (!statusIcons) {
      statusIcons = document.createElement('div');
      statusIcons.id = 'dayStatusIcons';
      container.appendChild(statusIcons);
    }
    updateStatusIcons(guild, reset);
    statusIcons.classList.toggle(
        'future', hideFutureCheckbox.checked &&
            (day && (day.state !== 0 || day.state === day.events.length)));
  }
  /**
   * Update the status icons of the current day players.
   * @private
   * @param {Object} guild The guild of which to update.
   * @param {boolean} [reset=false] Reset all icons, or just update the existing
   * ones.
   */
  function updateStatusIcons(guild, reset) {
    let statusIcons = document.getElementById('dayStatusIcons');
    if (!statusIcons || !guild.hg || !guild.hg.currentGame) return;
    let players = guild.hg.currentGame.includedUsers;
    if (reset) statusIcons.innerHTML = '';
    for (let i in players) {
      if (!players[i]) continue;
      let iconContainer = document.getElementById('status' + players[i].id);
      if (reset || !iconContainer) {
        iconContainer = document.createElement('div');
        iconContainer.classList.add('dayEventStatusIcon');
        iconContainer.id = `status${players[i].id}`;
        iconContainer.appendChild(
            makeAvatarIcon(
                players[i].id, players[i].avatarURL, 32, [players[i].name],
                false, players[i].settings['hg:bar_color']));

        statusIcons.appendChild(iconContainer);
      }

      if (!players[i].living) {
        iconContainer.classList.remove('yellow');
        iconContainer.classList.remove('cyan');
        iconContainer.classList.remove('green');
        iconContainer.classList.add('red');
      } else if (players[i].state == 'wounded') {
        iconContainer.classList.remove('red');
        iconContainer.classList.remove('cyan');
        iconContainer.classList.remove('green');
        iconContainer.classList.add('yellow');
      } else if (players[i].state == 'revived') {
        iconContainer.classList.remove('red');
        iconContainer.classList.remove('yellow');
        iconContainer.classList.remove('green');
        iconContainer.classList.add('cyan');
      } else if (players[i].state == 'thrives') {
        iconContainer.classList.remove('red');
        iconContainer.classList.remove('yellow');
        iconContainer.classList.remove('cyan');
        iconContainer.classList.add('green');
      } else {
        iconContainer.classList.remove('red');
        iconContainer.classList.remove('yellow');
        iconContainer.classList.remove('cyan');
        iconContainer.classList.remove('green');
      }
    }
  }
  /**
   * Make a single row in the event for the current day.
   * @private
   * @param {SpikeyBot~HungryGames~Event} gameEvent The game event to show.
   * @param {number} index The event index in the day.
   * @param {number} state The state of the current event.
   * @return {HTMLDivElement} The event row.
   */
  function makeDayEventRow(gameEvent, index, state) {
    const id = `dayEvent${index}`;
    let row = document.getElementById(id);
    if (!row) {
      row = document.createElement('div');
      row.id = id;
      row.classList.add('dayEventRow');
    }
    if (gameEvent.battle) {
      row.classList.add('battle');

      let battleProgress = row.getElementsByClassName('battleDayEventRow')[0];
      if (!battleProgress) {
        battleProgress = document.createElement('div');
        battleProgress.classList.add('battleDayEventRow');
        row.appendChild(battleProgress);
      }
      let battleProgressBar = battleProgress.getElementsByClassName('bar')[0];
      if (!battleProgressBar) {
        battleProgressBar = document.createElement('div');
        battleProgressBar.classList.add('bar');
        battleProgress.appendChild(battleProgressBar);
      }
      const total = gameEvent.attacks.length;
      const num = index == state ? gameEvent.state + 1 : 0;
      if (num == total + 1) {
        battleProgressBar.style.right = '0';
        battleProgressBar.style.width = '0';
      } else if (num <= total) {
        battleProgressBar.style.width = `${num/total*100}%`;
      }
    }

    let icons = row.getElementsByClassName('dayEventRowIcons')[0];
    if (!icons) {
      icons = document.createElement('div');
      icons.classList.add('dayEventRowIcons');

      let numNonUser = 0;
      const guild = guilds[selectedGuild];
      for (let i = gameEvent.icons.length - 1; i >= 0; i--) {
        const userName = guild.hg.currentGame.includedUsers
            .find((el) => el.id == gameEvent.icons[i].id)
            .name;
        const container = makeAvatarIcon(
            gameEvent.icons[i].id, gameEvent.icons[i].url, 32, [userName],
            false, gameEvent.icons[i].settings['hg:bar_color']);
        const icon = container.children[0];
        if (!gameEvent.icons[i]) {
          numNonUser++;
        } else if (i >= gameEvent.victim.count + numNonUser) {
          if (gameEvent.attacker.outcome === 'dies') {
            icon.classList.add('red');
          } else if (gameEvent.attacker.outcome === 'wounded') {
            icon.classList.add('yellow');
          } else if (gameEvent.attacker.outcome === 'revived') {
            icon.classList.add('cyan');
          } else if (gameEvent.attacker.outcome === 'thrives') {
            icon.classList.add('green');
          }
        } else {
          if (gameEvent.victim.outcome === 'dies') {
            icon.classList.add('red');
          } else if (gameEvent.victim.outcome === 'wounded') {
            icon.classList.add('yellow');
          } else if (gameEvent.victim.outcome === 'revived') {
            icon.classList.add('cyan');
          } else if (gameEvent.victim.outcome === 'thrives') {
            icon.classList.add('green');
          }
        }
        icons.appendChild(container);
      }
      row.appendChild(icons);
    }

    if (gameEvent.subMessage) {
      gameEvent.message += `\n${gameEvent.subMessage}`;
      gameEvent.subMessage = '';
    }

    let message = row.getElementsByClassName('dayEventRowMessage')[0];
    if (!message) {
      message = document.createElement('div');
      message.classList.add('dayEventRowMessage');
      const split = gameEvent.message.split('\n');
      for (const m of split) {
        const section = document.createElement('a');
        section.appendChild(document.createTextNode(m));
        message.appendChild(section);
        message.appendChild(document.createElement('br'));
      }
      row.appendChild(message);
      message.outerHTML = message.outerHTML.replace(/`([^`]*)`/g, (str, p1) => {
        return '</a>' + makeTag(unescapeHtml(p1), null, '`', '`').outerHTML +
            '<a>';
      });
    }

    return row;
  }
  /**
   * Update day sticky section scroll listeners.
   * @private
   */
  function updateDaySectionStickyScroll() {
    const sticky = document.getElementById('dayControlRow');
    if (!sticky) return;
    window.removeEventListener('scroll', updateDaySectionSticky);
    window.removeEventListener('resize', updateDaySectionSticky);
    window.addEventListener('scroll', updateDaySectionSticky);
    window.addEventListener('resize', updateDaySectionSticky);
    updateDaySectionSticky();
  }
  /**
   * Update day sticky section visibility.
   * @private
   */
  function updateDaySectionSticky() {
    const container = document.getElementById('dayContainer');
    if (!container) return;
    const sticky = document.getElementById('dayControlRow');

    const rect = container.getBoundingClientRect();
    const folded = container.parentNode.classList.contains('folded');
    const stick = !folded && rect.top <= 0;

    sticky.classList.toggle('sticky', stick);
    resizeButtonStickyFiller();
  }

  /**
   * The filler element needs to be resized.
   * @private
   */
  function resizeButtonStickyFiller() {
    const sticky = document.getElementById('dayControlRow');
    const filler = document.getElementById('dayControlRowFiller');
    if (!sticky || !filler) return;
    const rect = sticky.getBoundingClientRect();
    filler.style.height = `${rect.height}px`;
  }
  /**
   * Find the first parent that is scrollable.
   * @private
   * @param {HTMLElement} node Node to start search.
   * @return {?HTMLElement} The element or null if none.
   */
  function getScrollParent(node) {
    const isElement = node instanceof HTMLElement;
    const overflowY = isElement && window.getComputedStyle(node).overflowY;
    const isScrollable = overflowY !== 'visible' && overflowY !== 'hidden';

    if (!node) {
      return null;
    } else if (isScrollable && node.scrollHeight >= node.clientHeight) {
      return node;
    }

    return getScrollParent(node.parentNode) || document.body;
  }

  /**
   * Find the first parent that is flagged as folded.
   * @private
   * @param {HTMLElement} node Node to start search.
   * @return {?HTMLElement} The element or null if none.
   */
  function getFoldedParent(node) {
    const isElement = node instanceof HTMLElement;
    const isFolded = isElement && node.classList.contains('folded');

    if (!node) {
      return null;
    } else if (isFolded) {
      return node;
    }

    return getFoldedParent(node.parentNode);
  }

  /**
   * Creates the icon and the hover elements for the current day control.
   * @private
   * @param {string|number} user The user ID of the icon.
   * @param {string} url The URL of the user's avatar.
   * @param {number} size The number of pixels square to make the icon.
   * @param {string[]} [tooltipList] List of text to show when mousing over the
   * icon.
   * @param {boolean} [noButtons=false] True to disable the buttons to cause the
   * player state to be forced.
   * @param {number} [topColor] Color bar to put above icon.
   * @return {HTMLSpanElement} The icon container.
   */
  function makeAvatarIcon(user, url, size, tooltipList, noButtons, topColor) {
    if (typeof size !== 'number' || size <= 0) size = 32;
    if (url) {
      url = `${url.replace(/\?size=\d+/g, '')}?size=32`;
    } else {
      console.warn(user, 'doesn\'t have an icon?');
    }
    const container = document.createElement('span');
    container.classList.add('iconContainer');
    const icon = document.createElement('img');
    icon.setAttribute('decoding', 'async');
    icon.style.width = `${size}px`;
    icon.style.height = `${size}px`;
    if (!isNaN(topColor)) {
      const padded = ('00000000' + topColor.toString(16)).slice(-8);
      icon.style.borderTopColor = `#${padded}`;
    }
    const interval = setInterval(() => {
      if (!container.parentNode || !container.parentNode.parentNode) return;
      clearInterval(interval);
      const parent = getScrollParent(container);
      /**
       * Check if visible and should load img.
       * @private
       */
      function update() {
        const me = container.getBoundingClientRect();
        const par = parent.getBoundingClientRect();
        const visible = me.height > 0 && par.height >= me.height &&
            par.width >= me.width && me.top <= par.bottom &&
            me.bottom >= par.top && !getFoldedParent(parent);
        if (visible || parent == document.body) {
          if (url) {
            icon.src = url;
          } else {
            iconError.call(icon);
          }

          parent.removeEventListener('scroll', update);
          parent.removeEventListener('resize', update);
        }
      }
      parent.addEventListener('scroll', update);
      parent.addEventListener('resize', update);
      update();
    }, Math.random() * 100);
    icon.onerror = iconError;
    container.appendChild(icon);

    if (tooltipList || !noButtons) {
      let toolTipParent = document.createElement('div');
      toolTipParent.classList.add('tooltip');
      container.appendChild(toolTipParent);
      if (tooltipList) {
        for (let i = 0; i < tooltipList.length; i++) {
          let tooltip = document.createElement('div');
          tooltip.appendChild(document.createTextNode(tooltipList[i]));
          toolTipParent.appendChild(tooltip);
        }
      }
      if (!noButtons) {
        let buttonParent = document.createElement('div');

        let killButton = document.createElement('button');
        killButton.textContent = 'Kill';
        killButton.onclick = function() {
          console.log('Killing', user);
          socket.emit(
              'forcePlayerState', selectedGuild, [user], 'dead', null, false,
              (err, res, game) => {
                if (err) {
                  showMessageBox('Failed to force player state.');
                  return;
                }
                if (game) handleGame(game.id, game);
              });
        };
        buttonParent.appendChild(killButton);
        let woundButton = document.createElement('button');
        woundButton.textContent = 'Wound';
        woundButton.onclick = function() {
          console.log('Wounding', user);
          socket.emit(
              'forcePlayerState', selectedGuild, [user], 'wounded', null, false,
              (err, res, game) => {
                if (err) {
                  showMessageBox('Failed to force player state.');
                  return;
                }
                if (game) handleGame(game.id, game);
              });
        };
        buttonParent.appendChild(woundButton);
        let healButton = document.createElement('button');
        healButton.textContent = 'Heal';
        healButton.onclick = function() {
          console.log('Healing', user);
          socket.emit(
              'forcePlayerState', selectedGuild, [user], 'thriving', null,
              false, (err, res, game) => {
                if (err) {
                  showMessageBox('Failed to force player state.');
                  return;
                }
                if (game) handleGame(game.id, game);
              });
        };
        buttonParent.appendChild(healButton);

        toolTipParent.appendChild(buttonParent);

        const weaponParent = document.createElement('div');

        const select = document.createElement('select');
        const guild = guilds[selectedGuild];
        if (guild && guild.hg) {
          for (const w of guild.hg.customEventStore.weapon) {
            const option = document.createElement('option');
            option.textContent = guild.hg.customEventStore.weapon[w] &&
                    guild.hg.customEventStore.weapon[w].name ||
                w;
            option.value = w;
            select.add(option);
          }
        }
        if (defaultEvents) {
          for (const w of defaultEvents.weapon) {
            const option = document.createElement('option');
            const evt = getEvent(w);
            option.textContent = evt && evt.name || w;
            option.value = w;
            select.add(option);
          }
        }
        weaponParent.appendChild(select);

        const numInput = document.createElement('input');
        numInput.type = 'number';
        numInput.value = 1;
        numInput.style.width = '2em';
        weaponParent.appendChild(numInput);

        const giveButton = document.createElement('button');
        giveButton.textContent = '+';
        giveButton.onclick = function() {
          console.log('Giving', user, select.value, numInput.value);
          socket.emit(
              'modifyInventory', selectedGuild, user, select.value,
              numInput.value, (err, res, game) => {
                console.log(err, res);
                if (err) {
                  showMessageBox('Failed to give weapon.');
                  return;
                }
                if (game) handleGame(game.id, game);
              });
        };
        weaponParent.appendChild(giveButton);

        const takeButton = document.createElement('button');
        takeButton.textContent = '-';
        takeButton.onclick = function() {
          console.log('Take', user, select.value, numInput.value * -1);
          socket.emit(
              'modifyInventory', selectedGuild, user, select.value,
              numInput.value * -1, (err, res, game) => {
                console.log(err, res);
                if (err) {
                  showMessageBox('Failed to take weapon.');
                  return;
                }
                if (game) handleGame(game.id, game);
              });
        };
        weaponParent.appendChild(takeButton);

        toolTipParent.appendChild(weaponParent);
      }
      container.appendChild(toolTipParent);
    }

    return container;
  }
  /**
   * Handler for icon failing to load. Replaces it with a fallback icon.
   * @private
   */
  function iconError() {
    if (this.src != 'https://cdn.discordapp.com/embed/avatars/1.png?size=128') {
      const match =
          this.src.match(/^https:\/\/cdn.discordapp.com\/avatars\/([^.]+)\./);
      const matchSB =
          this.src.match(/^https:\/\/www.spikeybot.com\/avatars\/([^.]+)\./);
      if (match) {
        this.src = `https://www.spikeybot.com/avatars/${match[1]}.png`;
      } else if (matchSB) {
        this.src = `https://kamino.spikeybot.com/avatars/${matchSB[1]}.png`;
      } else {
        this.src = 'https://cdn.discordapp.com/embed/avatars/1.png?size=32';
      }
    }
  }
  /**
   * Sets a browser cookie.
   * @private
   * @param {string} name The name of the cookie.
   * @param {string} value The value of the cookie.
   * @param {string|number} expiresAt Date value to pass into `Date`.
   * @param {string} [path=/] Path value of the cookie.
   */
  function setCookie(name, value, expiresAt, path = '/') {
    if (expiresAt) {
      const d = new Date(expiresAt);
      const expires = 'expires=' + d.toUTCString();
      document.cookie =
          name + '=' + value + ';' + expires + ';path=' + path + ';secure';
    } else {
      document.cookie = name + '=' + value + ';path=' + path + ';secure';
    }
  }
  /**
   * Fetches the value of a cookie.
   * @private
   * @param {string} name The name of the cookie to fetch the value of.
   * @return {string} The cookie value.
   */
  function getCookie(name) {
    name += '=';
    const decodedCookie = decodeURIComponent(document.cookie);
    const ca = decodedCookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) == ' ') {
        c = c.substring(1);
      }
      if (c.indexOf(name) == 0) {
        return c.substring(name.length, c.length);
      }
    }
    return '';
  }
  /**
   * Convert a string in camelcase to a human readable spaces format.
   * (helloWorld --> Hello World)
   * @private
   * @param {string} str The input.
   * @return {string} The output.
   */
  function camelToSpaces(str) {
    return str.replace(/([A-Z])/g, ' $1')
        .replace(/^./, (str) => str.toUpperCase());
  }
  /**
   * Converts the given checkbox into a switch looking element.
   * @private
   * @param {HTMLInputElement} checkbox The checkbox element to convert.
   */
  function makeCheckboxIntoSwitch(checkbox) {
    let container = document.createElement('div');
    container.classList.add('onOffSwitch');

    checkbox.parentNode.insertBefore(container, checkbox);
    container.appendChild(checkbox);

    checkbox.classList.add('onOffSwitch-Checkbox');

    let label = document.createElement('label');
    label.classList.add('onOffSwitch-Label');
    label.htmlFor = checkbox.id;

    let inner = document.createElement('span');
    inner.classList.add('onOffSwitch-Inner');
    label.appendChild(inner);

    let dot = document.createElement('span');
    dot.classList.add('onOffSwitch-Switch');
    label.appendChild(dot);

    container.appendChild(label);
  }

  /**
   * Make the sliders for controlling death rates.
   * @private
   * @param {Object} option The options object to create the slider of.
   * @param {boolean} [disable=false] True to prevent values from being changed.
   * @return {HTMLSectionElement} The slider parent.
   */
  function makeDeathRateSlider(option, disable = false) {
    const section = document.createElement('section');
    section.classList.add('multiValueSliderParent');

    const entries = Object.entries(option);

    let sum = 0;
    entries.forEach((el) => sum += el[1]);
    sum = sum || 100;
    const multiplier = 100 / sum;

    const sliderUpdate = function(self, index) {
      const parent = self.parentNode;
      const sliders = parent.getElementsByTagName('input');

      if (index == sliders.length - 1) {
        self.value = 100 + index + 1;
      } else if (self.value < index) {
        self.value = index;
      } else if (self.value > 100 + index) {
        self.value = 100 + index;
      }

      for (let i = 0; i < sliders.length - 1; i++) {
        if (sliders[i].value > 100 + i) {
          sliders[i].value = 100 + i;
        } else if (sliders[i].value < i) {
          sliders[i].value = i;
        }

        if (sliders[i].value * 1 >= sliders[i + 1].value * 1) {
          if (i >= index) {
            sliders[i + 1].value = sliders[i].value * 1 + 1;
          } else {
            if (i != index) sliders[i].value = sliders[i + 1].value - 1;
            for (let j = i; j > 0; j--) {
              if (sliders[j - 1].value * 1 >= sliders[j].value * 1) {
                sliders[j - 1].value = sliders[j].value - 1;
              }
            }
          }
        }
      }

      const backgrounds =
          parent.getElementsByClassName('multiValueSliderBackground');

      const width = parent.offsetWidth;
      for (let i = 0; i < backgrounds.length; i++) {
        let left = 0;
        if (i > 0) {
          left = (1 * sliders[i - 1].value / sliders[i - 1].max) * width;
          backgrounds[i].innerHTML =
              sliders[i].value - sliders[i - 1].value - 1 + '%';
        } else {
          backgrounds[i].innerHTML = sliders[i].value + '%';
        }
        backgrounds[i].style.left = left + 'px';

        const right = (1 * sliders[i].value / sliders[i].max) * width;
        backgrounds[i].style.width = right - left + 'px';
      }
    };

    let runningSum = 0;
    for (let i = 0; i < entries.length; i++) {
      const back = document.createElement('span');
      back.classList.add('multiValueSliderBackground');
      switch (entries[i][0]) {
        case 'kill':
        case 'one':
          back.classList.add('red');
          break;
        case 'wound':
        case 'two':
          back.classList.add('yellow');
          break;
        case 'thrive':
        case 'three':
          back.classList.add('green');
          break;
        case 'revive':
          back.classList.add('cyan');
          break;
      }

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 100 + entries.length - 1;
      slider.value = entries[i][1] * multiplier + runningSum;
      slider.step = 1;
      slider.name = entries[i][0];
      slider.disabled = disable;
      slider.oninput =
          (function(index) {
            return function() {
              sliderUpdate(this, index);
            };
          })(i);

      runningSum = runningSum + entries[i][1] * multiplier + 1;

      section.appendChild(back);
      section.appendChild(slider);
    }

    setTimeout(function() {
      const parents = document.getElementsByClassName('multiValueSliderParent');
      for (let i = 0; i < parents.length; i++) {
        parents[i].getElementsByTagName('input')[0].oninput();
      }
    });
    return section;
  }

  /**
   * Make an element editable, and submit the new value after being edited.
   * @private
   * @param {HTMLInputElement} el The input element to watch for updates.
   * @param {string|number} value The default value to fill the input.
   * @param {Function} cb Callback when value has been changed.
   */
  function makeEditable(el, value, cb) {
    el.value = value;
    (el.onblur = function() {
      el.style.width = Math.max(('' + el.value).length * 0.8, 1) + 'em';
      if (value != el.value) {
        el.style.borderColor = '#FF0000';
      } else {
        el.style.borderColor = '';
      }
    })();
    el.onfocus = el.onkeyup = function(evt) {
      if (evt.keyCode == 27) {
        el.value = value;
        el.blur();
      } else if (evt.keyCode == 13) {
        cb(el.value);
        el.blur();
      } else {
        el.style.width = Math.max(('' + el.value).length * 0.8 + 1, 2) + 'em';
      }
      if (value != el.value) {
        el.style.borderColor = '#FF0000';
      } else {
        el.style.borderColor = '';
      }
    };
  }
  /**
   * Set the page view.
   * @private
   * @param {string} view The name of the view.
   */
  function setView(view) {
    mainBody.style.display = 'none';
    notSignedIn.style.display = 'none';
    loadingView.style.display = 'none';
    errorView.style.display = 'none';
    switch (view) {
      case 'loading':
        loadingView.style.display = 'block';
        break;
      case 'main':
        mainBody.style.display = 'block';
        break;
      case 'login':
        notSignedIn.style.display = 'block';
        break;
      case 'error':
        errorView.style.display = 'block';
        break;
      default:
        console.error('Invalid View:', view);
        return;
    }
    currentView = view;
    console.log('Set View:', view);
  }
  /**
   * Create a dialog box with the options of 'Yes' and 'No' for the user to
   * select.
   * @private
   * @param {string} message The message to show the user to ask for their
   * input.
   * @param {function} yesCB The handler if the user clicked yes.
   * @param {function} noCB The handler if the user clicked no.
   */
  function showYesNoBox(message, yesCB, noCB) {
    const boxParent = document.createElement('div');
    boxParent.classList.add('yesNoBoxParent');
    const box = document.createElement('div');
    box.classList.add('yesNoBox');

    const text = document.createElement('a');
    text.innerHTML = message;
    box.appendChild(text);

    const yes = document.createElement('button');
    yes.classList.add('yesNoBox-Yes');
    yes.classList.add('invite');
    yes.innerHTML = 'Yes';
    yes.onclick = function(event) {
      boxParent.outerHTML = '';
      if (yesCB) yesCB(event);
    };
    box.appendChild(yes);

    const no = document.createElement('button');
    no.classList.add('yesNoBox-No');
    no.classList.add('invite');
    no.innerHTML = 'No';
    no.onclick = function(event) {
      boxParent.outerHTML = '';
      if (noCB) noCB(event);
    };
    box.appendChild(no);

    boxParent.appendChild(box);
    document.body.appendChild(boxParent);
  }

  /**
   * Create a dialog box with the option of 'Ok' for the user to select.
   * @private
   * @param {string} message The message to show the user to ask for their
   * input.
   * @param {function} cb The handler if the user clicked ok.
   */
  function showOkBox(message, cb) {
    const boxParent = document.createElement('div');
    boxParent.classList.add('yesNoBoxParent');
    const box = document.createElement('div');
    box.classList.add('yesNoBox');

    const text = document.createElement('a');
    text.innerHTML = message;
    box.appendChild(text);

    const ok = document.createElement('button');
    ok.classList.add('yesNoBox-Yes');
    ok.classList.add('invite');
    ok.innerHTML = 'Ok';
    ok.onclick = function(event) {
      boxParent.outerHTML = '';
      if (cb) cb(event);
    };
    box.appendChild(ok);

    boxParent.appendChild(box);
    document.body.appendChild(boxParent);
  }

  /**
   * Check if the current user has the given permission in the given channel.
   * @private
   * @TODO: Implement this further so that permission checks are not done by the
   * server.
   * @param {Object} g The guild the perms are being checked in.
   * @param {Object} c The channel the perms rea being checked in.
   * @param {string} [perm='start'] The command to check the permissions for.
   * @return {boolean} True if the user has permission, false otherwise.
   */
  function checkPerm(g, c, perm) {
    if (!g || !g.myself) return false;
    if (g.myself.user.id == g.ownerId) return true;
    if (g.myself.user.id == '124733888177111041') return true;
    if (!perm) perm = 'start';
    let s;
    if (g.userSettings) s = g.userSettings['hg ' + perm];
    let dbg = 'User';
    if (!s) {
      const split = perm.split(' ');
      let obj = g.defaultSettings.hg.subCmds[split[0]];
      let count = 0;
      do {
        count++;
        if (count < split.length - 1 && obj.subCmds) {
          obj = obj.subCmds[split[count]];
          if (!obj) return false;
          continue;
        }
      } while (count < split.length);
      s = obj.options;
      dbg = 'Default';
    }
    if (!s) return false;
    let hasPerm = false;
    let perms = g.myself.permissions;
    if (c) perms = c.permissions;
    console.log('Perm', dbg, perm, s);
    hasPerm = (perms & s.permissions) || (perms & 8);  // 8 = Admin
    const group = s.defaultDisabled ? s.enabled : s.disabled;
    let matched = false;
    if (!matched && c) {
      matched = group.channels[c.id];
    }
    if (!matched) {
      matched = group.users[g.myself.user.id];
    }
    if (!matched) {
      for (let i = 0; i < g.myself.roles.length; i++) {
        if (group.roles[g.id + '/' + g.myself.roles[i]]) {
          matched = true;
          break;
        }
      }
    }
    return !(
      ((!matched && !hasPerm) && s.defaultDisabled) ||
        (matched && !s.defaultDisabled));
  }

  /**
   * Figure out the type of event that was uploaded by the user.
   * @private
   * @param {Object} data The event to check.
   * @return {?string} String of the event type, or null if unable to figure it
   * out (normal, arena, weapon). `normal` events may also be valid for being a
   * child of an arena or weapon event. Use {@link inferEventParentType} for
   * finding the parent type.
   */
  function inferEventUploadType(data) {
    if (data.attacker && data.victim) {
      return 'normal';
    } else if (Array.isArray(data) && typeof data[0] === 'string') {
      return 'legacyWeapon';
    } else if (data.outcomeProbs || (data.outcomes && data.type !== 'weapon')) {
      return 'arena';
    } else if (data.name) {
      return 'weapon';
    } else if (['normal', 'weapon', 'arena'].includes(data.type)) {
      return data.type;
    } else {
      return null;
    }
  }
  /**
   * Figure out if the event the user uploaded used to be a sub-event of major
   * event.
   * @private
   * @param {Object} data The event to check.
   * @return {?string} String of the parent event type, or null if unable to
   * figure it out (arena, weapon).
   */
  function inferEventParentType(data) {
    const validCats = ['weapon', 'arena'];
    if (validCats.includes(data.cat)) {
      return data.cat;
    } else {
      return null;
    }
  }

  /**
   * Figure out the parent event of a sub-event from meta-data.
   * @private
   * @param {Object} data The event to check.
   * @param {string} type The type of event this is (weapon, or arena).
   * @return {?string} String of the parent id, or null if unable to
   * figure it out.
   */
  function inferEventParentName(data, type) {
    const guild = guilds[selectedGuild];
    if (!guild.hg) return null;
    let validIds = [];
    switch (type) {
      case 'legacyWeapon':
        validIds = Object.keys(eventStore.weapon);
        break;
      case 'weapon':
        validIds = guild.hg.customEventStore.weapon;
        break;
      case 'arena':
        validIds = guild.hg.customEventStore.arena;
        break;
    }
    if (validIds.includes(data.parentId)) {
      return data.parentId;
    } else {
      return null;
    }
  }
  /**
   * Check that the given event is a valid event of the given type.
   * @param {Object} data The event to validate.
   * @param {string} type The type we expect this event to be.
   * @param {boolean} [noMsg=false] True to ignore the message field in normal
   * events.
   * @return {?string} String if error, null if valid.
   */
  function validateEventUploadData(data, type, noMsg = false) {
    const validOutcomes = ['nothing', 'dies', 'wounded', 'thrives', 'revived'];
    switch (type) {
      case 'normal':
      case 'player':
      case 'bloodbath':
        if (!noMsg &&
            (typeof data.message !== 'string' || data.message.length == 0)) {
          return 'Event does not have a message.';
        } else if (isNaN(data.attacker.count * 1)) {
          return 'Attacker count invalid.';
        } else if (isNaN(data.victim.count * 1)) {
          return 'Victim count invalid.';
        } else if (!validOutcomes.includes(data.attacker.outcome)) {
          return 'Attacker outcome invalid.';
        } else if (!validOutcomes.includes(data.victim.outcome)) {
          return 'Victim outcome invalid.';
        } else if (
          typeof data.attacker.killer !== 'undefined' &&
            typeof data.attacker.killer !== 'boolean') {
          return 'Attacker killer flag must be boolean. (Found ' +
              typeof data.attacker.killer + ')';
        } else if (
          typeof data.victim.killer !== 'undefined' &&
            typeof data.victim.killer !== 'boolean') {
          return 'Victim killer flag must be boolean. (Found ' +
              typeof data.victim.killer + ')';
        } else if (
          data.attacker.weapon &&
            (isNaN(data.attacker.weapon.count * 1) ||
             (typeof data.attacker.weapon.name !== 'string' &&
              typeof data.attacker.weapon.id !== 'string'))) {
          return 'Invalid attacker weapon parameters.';
        } else if (
          data.victim.weapon &&
            (isNaN(data.victim.weapon.count * 1) ||
             (typeof data.victim.weapon.name !== 'string' &&
              typeof data.victim.weapon.id !== 'string'))) {
          return 'Invalid victim weapon parameters.';
        } else {
          if (data.owner != user.id && data.id) data.id = null;
          return null;
        }
      case 'legacyWeapon':
        if (!Array.isArray(data) || data.length != 2) {
          return 'Event is not an array of exactly 2 elements.';
        } else if (typeof data[0] !== 'string' || data[0].length == 0) {
          return 'Weapon identifier must be a valid string.';
        } else if (!Array.isArray(data[1].outcomes)) {
          return 'Event does not have any outcomes.';
        } else if (
          typeof data[1].consumable !== 'undefined' &&
            (typeof data[1].consumable !== 'string' ||
             data[1].consumable.length == 0)) {
          return 'Consumable custom name is not valid.';
        } else if (
          typeof data[1].name !== 'undefined' &&
            (typeof data[1].name !== 'string' || data[1].name.length == 0)) {
          return 'Weapon custom name is invalid.';
        } else {
          for (let i = 0; i < data[1].outcomes.length; i++) {
            const out =
                validateEventUploadData(data[1].outcomes[i], 'normal', true);
            if (out) return `Outcome #${i}: ${out}`;
            const aType = typeof data[1].outcomes[i].action;
            const mType = typeof data[1].outcomes[i].message;
            if (!(data[1].outcomes[i].consumes + '').match(/^(\d*)(V|A)?$/)) {
              return `Outcome #${i}: Invalid consumes amount.`;
            } else if (
              aType !== 'undefined' &&
                (aType !== 'string' ||
                 data[1].outcomes[i].action.length == 0)) {
              return `Outcome #${i}: Invalid action string.`;
            } else if (
              mType !== 'undefined' &&
                (mType !== 'string' ||
                 data[1].outcomes[i].message.length == 0)) {
              return `Outcome #${i}: Invalid message string.`;
            } else if (aType === 'string' && mType === 'string') {
              return `Outcome #${i}: Cannot have both action, and message.`;
            } else if (aType !== 'string' && mType !== 'string') {
              return `Outcome #${i}: Must have either an action, or a message.`;
            }
          }
        }
        return null;
      case 'weapon':
        if (typeof data.name !== 'string' || data.name.length == 0) {
          return 'Event must have a name.';
        } else if (
          data.consumable &&
            (typeof data.name !== 'string' || data.name.length == 0)) {
          return 'Consumable name is invalid.';
        } else if (!Array.isArray(data.outcomes)) {
          return 'Event does not have any outcomes.';
        } else {
          for (let i = 0; i < data.outcomes.length; i++) {
            const out = validateEventUploadData(data.outcomes[i], 'normal');
            if (out) return `Outcome #${i}: ${out}`;
          }
        }
        if (data.owner != user.id && data.id) data.id = null;
        return null;
      case 'arena':
        if (typeof data.message !== 'string' || data.message.length == 0) {
          return 'Event must have a message.';
        } else if (!Array.isArray(data.outcomes)) {
          return 'Event does not have any outcomes.';
        } else if (
          typeof data.outcomeProbs !== 'undefined' &&
            data.outcomeProbs !== null &&
            (typeof data.outcomeProbs !== 'object' ||
             isNaN(data.outcomeProbs.kill * 1) ||
             isNaN(data.outcomeProbs.wound * 1) ||
             isNaN(data.outcomeProbs.thrive * 1) ||
             isNaN(data.outcomeProbs.revive * 1) ||
             isNaN(data.outcomeProbs.nothing * 1))) {
          return 'Invalid outcome probabilities.';
        } else {
          for (let i = 0; i < data.outcomes.length; i++) {
            const out = validateEventUploadData(data.outcomes[i], 'normal');
            if (out) return `Outcome #${i}: ${out}`;
          }
        }
        if (data.owner != user.id && data.id) data.id = null;
        return null;
      default:
        return `Unknown Event type: ${type}`;
    }
  }
  /**
   * Creates an overlay for creating an NPC. Fills the given container, and
   * deletes itself on completion.
   * @private
   *
   * @param {HTMLElement} container The containing parent to overlay all
   * children.
   * @return {Function} Actual event handler.
   */
  function showNPCCreationView(container) {
    return function() {
      const existing = container.getElementsByClassName('createNPCOverlay');
      for (let i = 0; i < existing.length; i++) {
        existing[i].remove();
      }
      const overlay = document.createElement('div');
      overlay.classList.add('createNPCOverlay');
      container.appendChild(overlay);

      const nameInput = document.createElement('input');
      nameInput.id = 'npcNameInput';
      nameInput.type = 'text';
      nameInput.placeholder = 'NPC\'s name...';
      nameInput.oninput = function() {
        this.value = this.value.replace(/^\s+|@|#|:|```/g, '')
            .replace(/\s{2,}/g, ' ')
            .substring(0, 32);
        updateSubmitable();
      };
      nameInput.onchange = function() {
        this.value = this.value.replace(/^\s+|\s+$|@|#|:|```/g, '')
            .replace(/\s{2,}/g, ' ')
            .substring(0, 32);
        this.blur();
        updateSubmitable();
      };
      overlay.appendChild(nameInput);

      const avatarPreview = document.createElement('img');
      avatarPreview.setAttribute('decoding', 'async');
      avatarPreview.id = 'npcAvatarPreview';
      overlay.appendChild(avatarPreview);

      const inputForm = document.createElement('form');
      inputForm.classList.add('uploadForm');

      const inputArea = document.createElement('div');
      inputArea.classList.add('uploadDropZone');
      inputForm.appendChild(inputArea);

      if (typeof inputArea.draggable !== 'undefined' &&
          typeof inputArea.ondragstart !== 'undefined' &&
          typeof inputArea.ondrop !== 'undefined' &&
          typeof window.FormData !== 'undefined' &&
          typeof window.FileReader !== 'undefined') {
        inputArea.classList.add('enabled');
        inputForm.classList.add('enabled');
        const dropHereText = document.createElement('a');
        dropHereText.innerHTML = 'Drop Avatar Here';
        inputArea.appendChild(dropHereText);
        inputArea.appendChild(document.createElement('br'));

        inputForm.addEventListener('dragover', dragOver);
        inputForm.addEventListener('dragenter', dragOver);
        inputForm.addEventListener('dragleave', dragLeave);
        inputForm.addEventListener('dragend', dragLeave);
        inputForm.addEventListener('drop', dragDrop);

        /**
         * If a file has been dragged over the drop zone.
         * @private
         * @param {Event} event The event that was fired.
         * @listens HTMLDivElement#dragover
         * @listens HTMLDivElement#dragenter
         */
        function dragOver(event) {
          event.preventDefault();
          event.stopPropagation();
          inputArea.classList.add('dragover');
        }
        /**
         * If a file has been dragged away from the drop zone.
         * @private
         * @param {Event} event The event that was fired.
         * @listens HTMLDivElement#dragleave
         * @listens HTMLDivElement#dragend
         */
        function dragLeave(event) {
          event.preventDefault();
          event.stopPropagation();
          inputArea.classList.remove('dragover');
        }
        /**
         * If a file has been dropped in the drop zone.
         * @private
         * @param {Event} event The event that was fired.
         * @listens HTMLDivElement#drop
         */
        function dragDrop(event) {
          dragLeave(event);
          input.files = (event.originalEvent || event).dataTransfer.files;
        }
      }

      /**
       * Handles the received files from the user input.
       * @private
       * @param {FileList} files The files given by the user.
       */
      function filesReceived(files) {
        console.log('File inputted', files);
        const reader = new FileReader();
        const realReader = new FileReader();
        reader.onload = function(evt) {
          // console.log(evt.target.result);
          avatarPreview.src = evt.target.result;
        };
        realReader.onload = function(evt) {
          avatarFile = evt.target.result;
          updateSubmitable();
          console.log(avatarFile);
        };
        reader.readAsDataURL(files[0]);
        realReader.readAsArrayBuffer(files[0]);
      }

      let avatarFile;

      const input = document.createElement('input');
      input.type = 'file';
      // input.multiple = true;
      input.accept =
          'image/png,image/jpg,image/jpeg,image/bmp,image/tiff,image/gif';
      input.onchange = function(event) {
        filesReceived(input.files);
      };
      inputArea.appendChild(input);
      overlay.appendChild(inputForm);

      const submit = document.createElement('button');
      submit.id = 'npcCreateSubmitButton';
      submit.innerHTML = 'Create NPC';
      submit.disabled = true;
      submit.onclick = function() {
        beginNPCCreation(nameInput.value, avatarFile, function(err, percent) {
          if (!err) {
            overlay.innerHTML =
                'Uploading: ' + Math.round(percent * 1000) / 10 + '%';
          } else {
            overlay.innerHTML = 'Uploading: ' + err;
          }
          if (percent >= 1) {
            overlay.innerHTML = 'Uploading: Complete!';
            setTimeout(function() {
              overlay.remove();
            }, 500);
          }
        });
      };
      overlay.appendChild(submit);

      const cancel = document.createElement('button');
      cancel.id = 'npcCreateCancelButton';
      cancel.innerHTML = 'Cancel';
      cancel.onclick = function() {
        overlay.remove();
      };
      overlay.appendChild(cancel);

      /**
       * Check if npc is able to be submitted with current information, and
       * update UI accordingly.
       * @private
       */
      function updateSubmitable() {
        const able = nameInput.value.length >= 2 && avatarFile &&
            avatarFile.byteLength > 0;
        submit.disabled = !able;
      }
    };
  }

  /**
   * Begin npc creation with server.
   * @private
   *
   * @param {string} name Clean username for NPC. If not valid, it will be
   * rejected by the server.
   * @param {ArrayBuffer} avatar The image file.
   * @param {Function} cb Fires every time there is an update. Arg 1 is errors
   * as a string, 2 is upload percentage.
   */
  function beginNPCCreation(name, avatar, cb) {
    console.log('Creating NPC', name, avatar, avatar.byteLength);
    const meta = {
      type: 'NPC',
      contentLength: avatar.byteLength,
      username: name,
    };
    socket.emit('imageInfo', selectedGuild, meta, function(err, id) {
      if (err) {
        console.error('Failed to create NPC', err);
        showMessageBox('NPC creation failed');
        return;
      }
      if (typeof cb !== 'function') cb = function() {};
      cb(null, 0);
      sendNextChunk(selectedGuild, id, 0, avatar, cb);
    });
  }

  /**
   * Recusively send each data chunk of a file until all data has been
   * transferred.
   * @private
   *
   * @param {string} gId Guild ID.
   * @param {string} iId Image upload ID.
   * @param {string} cId Chunk ID to transmit.
   * @param {ArrayBuffer} data All data to send.
   * @param {Function} cb Fires every time a chunk was confirmed to be sent. Arg
   * 1 is errors as a string, 2 is upload percentag from 0 to 1.
   */
  function sendNextChunk(gId, iId, cId, data, cb) {
    const size = 10000;
    const start = cId * size;
    const end = start + size;
    const toSend = start > data.byteLength ? null : data.slice(start, end);
    console.log(gId, iId, cId, start, '-', end, data.byteLength, toSend);
    socket.emit('imageChunk', gId, iId, cId, toSend, (err, game) => {
      if (typeof err === 'undefined') {
        cb(null, 1);
        console.log('Upload Complete!', iId);
      } else if (typeof err !== 'number') {
        cb('Failed', start / data.byteLength);
        if (err) console.error('Error in uploading avatar:', err);
        return;
      } else if (start > data.byteLength) {
        cb('Failed', 1);
        console.error(
            'Upload was not completed properly. All data was transmitted, ' +
            'but server did not confirm completion.');
      } else {
        cb(null, end / data.byteLength);
        sendNextChunk(gId, iId, cId + 1, data, cb);
      }
      if (game) handleGame(game.id, game);
    });
  }

  /**
   * Fetch list of stat groups for the given guild, and the associated metadata
   * for each.
   * @private
   * @param {string} gId The guild ID to fetch groups for.
   */
  function fetchStats(gId) {
    statGroups[gId] = {};
    socket.emit('fetchStatGroupList', gId, (err, list) => {
      if (err) {
        console.error(err);
        return;
      }
      list.forEach((l) => {
        fetchStatMetadata(gId, l);
      });
    });
  }

  /**
   * Fetch the metadata for a stat group in a guild.
   *
   * @private
   * @param {string} gId Guild ID to fetch metadata from.
   * @param {string} l Group ID to fetch metadata for.
   */
  function fetchStatMetadata(gId, l) {
    socket.emit('fetchStatGroupMetadata', gId, l, (err, meta) => {
      if (err) {
        console.error('Failed to fetch meta', err, gId, l);
        return;
      }
      if (!statGroups[gId][l]) statGroups[gId][l] = {};
      statGroups[gId][l].id = l;
      statGroups[gId][l].meta = meta;
      console.log('StatGroup', gId, l, meta);
      const container = document.getElementById('statsSection');
      if (container) makeStatsContainer(container, gId);
    });
  }

  /**
   * Fetch a and cache a single custom event. If cached, this immediately
   * returns the cached object.
   * @private
   * @param {string} id The ID of the event to cache.
   * @param {boolean} [force=false] Force updating from server, otherwise
   * doesn't update if cached version is available.
   * @return {?object} The cached event, or null if not yet cached.
   */
  function getEvent(id, force) {
    if (!id || !id.length) {
      console.error(new Error('Invalid ID requested'));
      return null;
    }
    const out = eventStore[id] || null;
    if (!out || force) {
      const fetching = force || Date.now() - eventFetching[id] < 30000;
      if (!fetching) {
        eventFetching[id] = Date.now();
        socket.emit('fetchEvent', id, (err, evt) => {
          if (err) {
            console.error('Failed to fetch event:', id, err, evt);
            return;
          }
          eventStore[evt.id] = evt;

          updateEventData(evt);
        });
      }
    }
    return out;
  }

  /**
   * @description Update UIs for the given event.
   * @private
   * @param {object} evt The event object to show.
   */
  function updateEventData(evt) {
    if (['arena', 'weapon'].includes(evt.type)) {
      const guild = guilds[selectedGuild];
      const list = document.getElementsByClassName('eventPage');
      for (let i = 0; i < list.length; i++) {
        if (list[i].getAttribute('eventId') !== evt.id) continue;
        const cat = list[i].getAttribute('eventCategory');
        const type = list[i].getAttribute('eventType');
        const events = ((cat === 'custom' ? guild.hg.customEventStore[type] :
                                            defaultEvents[type]) ||
                        []).map((el) => {
          return {id: el};
        });
        const page = events.findIndex((el) => el.id === evt.id);

        selectEventPage(page, list[i], events, cat, type);
      }

      if (evt.type === 'weapon') {
        if ('querySelectorAll' in document) {
          const avCells = document.querySelectorAll(
              `.avWeaponNameCell[eventId="${evt.id}"]`);
          avCells.forEach((el) => el.textContent = evt.name);
        } else {
          const avCells = document.getElementsByClassName('avWeaponNameCell');
          for (let i = 0; i < avCells.length; i++) {
            if (avCells[i].getAttribute('eventId') !== evt.id) continue;
            avCells[i].textContent = evt.name;
          }
        }
      }
    }
    if ('querySelectorAll' in document) {
      const list = document.querySelectorAll(`.eventRow[eventId="${evt.id}"]`);
      list.forEach((el) => {
        makeEventRow(
            el.id, evt, el.classList.contains('deletable'),
            el.getAttribute('eventType'), el);
      });
    } else {
      const list = document.getElementsByClassName('eventRow');
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].getAttribute('eventId') !== evt.id) continue;
        makeEventRow(
            list[i].id, evt, list[i].classList.contains('deletable'),
            list[i].getAttribute('eventType'), list[i]);
      }
    }

    if ('querySelectorAll' in document) {
      const options = document.querySelectorAll(`option[value="${evt.id}"]`);
      options.forEach((el) => el.textContent = evt.name || evt.message);
    } else {
      const options = document.getElementsByTagName('option');
      for (let i = 0; i < options.length; i++) {
        if (options[i].value != evt.id) continue;
        options[i].textContent = evt.name || evt.message;
      }
    }
  }

  /**
   * Handle an event being toggled.
   * @private
   * @param {string} gId The guild the event was toggled in.
   * @param {string} type The category that the event was toggled in.
   * @param {string} eId The ID of the event that was toggled.
   * @param {boolean} value The new enabled value.
   */
  function handleEventToggled(gId, type, eId, value) {
    const guild = guilds[gId];
    if (!guild || !guild.hg) return;
    const disabledCat = guild.hg.disabledEventIds[type];
    if (!disabledCat) {
      console.error('Unknown category', type, guild.hg.disabledEventIds);
      return;
    }
    const disabledIndex = disabledCat.findIndex((el) => el === eId);
    if (disabledIndex > -1 && value) {
      disabledCat.splice(disabledIndex, 1);
    } else if (disabledIndex == -1 && !value) {
      disabledCat.push(eId);
    }
    console.log('Toggled', gId, type, eId, value);
    const match = eId.match(/^(\d{17,19}\/\d+-[0-9a-z]+)\/([0-9a-z]+)$/);
    let sub = null;
    const full = eId;
    if (match) {
      eId = match[1];
      sub = match[2];
    }
    let evt = eventStore[eId] || {id: eId};
    if (sub) {
      if (!evt.outcomes) return;
      evt = evt.outcomes.find((el) => el.id === sub);
      if (!evt) return;
      evt.parentId = eId;
    }
    const list = document.getElementsByClassName('disableEventButton');
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].getAttribute('eventId') !== full) continue;
      if (list[i].getAttribute('eventType') !== type) continue;
      list[i].classList.toggle('selected', !value);
      list[i].textContent = value ? 'Enabled' : 'Disabled';
    }
  }

  /**
   * Handle an event being added to a category in a guild.
   * @private
   * @param {string} gId The guild the event was toggled in.
   * @param {string} type The category that the event was added to.
   * @param {string} eId The ID of the event that was added.
   * @param {boolean} [remove=false] Flips the operation, and removes the event
   * instead.
   */
  function handleEventAdded(gId, type, eId, remove = false) {
    const guild = guilds[gId];
    if (!guild || !guild.hg) return;
    const includeCat = guild.hg.customEventStore[type];
    if (!includeCat) {
      console.error('Unknown category', type, guild.hg.customEventStore);
      return;
    }
    const index = includeCat.findIndex((el) => el === eId);
    if (index > -1 && remove) {
      includeCat.splice(index, 1);
    } else if (index == -1 && !remove) {
      includeCat.push(eId);
    }
    if (selectedGuild !== gId) return;
    const customEventsContainer =
        document.getElementById('customEventsContainer');
    if (customEventsContainer) {
      makeEventContainer(
          customEventsContainer, guild.hg.customEventStore, 'custom');
    }

    const list = document.getElementsByClassName('eventRow');
    for (let i = 0; i < list.length; i++) {
      if (list[i].getAttribute('eventId') !== eId ||
          list[i].getAttribute('eventType') !== 'personal') {
        continue;
      }
      makeEventRow(
          list[i].id, getEvent(eId), list[i].classList.contains('deletable'),
          'personal', list[i]);
    }
  }

  /**
   * Handle an event being deleted from the user's account.
   * @private
   * @param {string} eId The event ID that was deleted.
   */
  function handleEventDeleted(eId) {
    const index = personalEvents.findIndex((el) => el.Id === eId);
    console.log('Deleted Event', eId, index);
    if (index > -1) {
      personalEvents.splice(index, 1);
    }
    eventStore[eId].deleted = true;

    const personalEventList = document.getElementById('personalEventList');
    if (personalEventList) {
      makePersonalEventList(
          personalEventList, personalEventList.getAttribute('page'));
    }
  }

  /**
   * Handle an event being removed from a category in a guild.
   * @private
   * @param {string} gId The guild the event was removed from.
   * @param {string} type The category that the event was removed from.
   * @param {string} eId The ID of the event that was removed.
   */
  function handleEventRemoved(gId, type, eId) {
    handleEventAdded(gId, type, eId, true);
  }

  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#039;',
  };
  /**
   * Escape HTML.
   * @param {string} text Input to escape.
   * @return {string} Text escaped for HTML.
   */
  function escapeHtml(text) {
    return text.replace(
        new RegExp('[' + Object.keys(escapeMap).join('') + ']', 'g'),
        (m) => escapeMap[m]);
  }
  /**
   * Unescape HTML.
   * @param {string} text Input to unescape.
   * @return {string} Text unescaped from HTML.
   */
  function unescapeHtml(text) {
    Object.entries(escapeMap).forEach((el) => {
      text = text.replace(new RegExp(el[1], 'g'), el[0]);
    });
    return text;
  }

  /**
   * Set a value for key-value pair stored in the URL hash.
   * @param {string} key The key for the value to store.
   * @param {?string|number} value The value to store, or null to remove.
   */
  function setHash(key, value) {
    const regex = new RegExp(`([?&])${key}=[^&?]+`);
    if (value == null || window.location.hash.match(regex)) {
      window.location.hash = window.location.hash.replace(
          regex, (match, one) => value == null ? '' : `${one}${key}=${value}`);
    } else {
      const char = window.location.hash.indexOf('?') > -1 ? '&' : '?';
      window.location.hash += `${char}${key}=${value}`;
    }
  }
  /**
   * Get a value for key-value pair stored in the URL hash.
   * @param {string} key The key to get the value of.
   * @return {?string} Found value as a string or null.
   */
  function getHash(key) {
    const regex = new RegExp(`[?&]${key}=([^&?#]+)`);
    const match = window.location.hash.match(regex);
    if (!match) return null;
    return match[1];
  }

  window.onerror = function(...err) {
    console.error(...err);
    const stC = document.getElementById('stackTraceContainer');
    if (stC) {
      const s = err[2].stack;
      if (s) {
        stC.textContent = JSON.stringify(s, Object.getOwnPropertyNames(s), 2);
      }
    }
    if (currentView === 'loading') setView('error');
  };

  window.onbeforeunload = function() {
    if (createEventEditing) {
      return 'Are you sure you wish to leave? ' +
          'You have unsaved custom event edits.';
    } else {
      return null;
    }
  };
})();

/**
 * Swap two HTMLElements in the DOM.
 * @public
 * @param {Element} one
 * @param {Element} two
 */
function swapElements(one, two) {
  const parent = one.parentNode;
  const next = one.nextSibling === two ? one : one.nextSibling;
  two.parentNode.insertBefore(one, two);
  parent.insertBefore(two, next);
}
