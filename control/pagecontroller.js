// Copyright 2018 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (web@campbellcrowley.com)

(function() {
  const authorizeUrl =
      'https://discord.com/api/oauth2/authorize?client_id=4442935347204587' +
      '53&redirect_uri=https%3A%2F%2Fwww.spikeybot.com%2Fredirect&response_ty' +
      'pe=code&scope=identify%20guilds';
  const loginButton = document.getElementById('loginButton');
  const sessionState = document.getElementById('sessionState');
  const mainBody = document.getElementById('mainBody');
  const notSignedIn = document.getElementById('notSignedIn');
  const loadingView = document.getElementById('loadingView');
  const isDev = location.pathname.startsWith('/dev/');
  // Random state value to ensure no tampering with requests during OAuth
  // sequence. I believe this is random enough for my purposes.
  const state =
      (isDev ? 'dev/control' : 'control') + Math.random() * 10000000000000000;
  const code = getCookie('code');
  let session = getCookie('session');
  let socket;

  let messageBoxDom = document.getElementById('messageBox');
  let messageBoxWrapperDom = document.getElementById('messageBoxWrapper');
  // Message Box //
  // Queue of messages.
  const messageBoxQueue = [];
  // Timeout for current open message box.
  let messageBoxTimeout;
  // Timeout for closing current message box.
  let messageBoxClearTimeout;

  let guilds = {};
  let settings = {};
  let guild;
  let user = {};
  let members = {};
  let channels = {};
  let selectedGuild;
  let unfoldedElements = [];
  let scheduledCmds = {};
  let raidSettingsTimeout;
  let modLogSettingsTimeout;
  let commandSettingsTimeout;

  let serverTimeOffset = 0;

  setInterval(function() {
    const datetimeEls = document.getElementsByClassName('datetime');
    if (datetimeEls.length == 0) return;
    const now = fullDateTime(
        Date.now() - serverTimeOffset, {seconds: true, timezone: true});
    for (let i = 0; i < datetimeEls.length; i++) {
      datetimeEls[i].textContent = now;
    }
  }, 1000);

  let guildList;

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
    user = {};
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
    socket =
        io('www.spikeybot.com',
           {path: isDev ? '/socket.io/dev/control' : '/socket.io/control'});
    socket.on('connect', function() {
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
    socket.on('authorized', function(err, data) {
      if (err) {
        console.log('Failed to authorize:', err);
        sessionState.innerHTML =
            'Failed to authorize. You may need to sign back in.';
        loginFailed = true;
        logout();
      } else {
        // console.log('Authorized:', data);
        console.log('Authorized:', data.username);
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
        socket.emit('fetchSettings', handleSettings);
        socket.emit('fetchScheduledCommands', handleScheduledCommands);
      }
    });
    socket.on('disconnect', function(reason) {
      console.log('Socket Disconnect:', reason);
      showMessageBox('Disconnected from server!');
      if (!session) {
        if (!loginFailed) sessionState.innerHTML = 'Disconnected. Signing out.';
        loginFailed = false;
        logout();
      } else {
        sessionState.innerHTML = 'Disconnected. Reconnecting...';
        socket.open();
      }
    });

    socket.on('guilds', handleGuilds);
    socket.on('settings', handleSettings);
    socket.on('scheduledCmds', handleScheduledCommands);
    socket.on('time', handleTime);
    socket.on('commandRegistered', handleCommandRegistered);
    socket.on('commandCancelled', handleCommandCancelled);
    socket.on('settingsChanged', handleSettingsChanged);
    socket.on('settingsReset', handleSettingsReset);
    socket.on('raidSettingsChanged', handleRaidSettingsChanged);
    socket.on('modLogSettingsChanged', handleModLogSettingsChanged);
    socket.on('commandSettingsChanged', handleCommandSettingsChanged);
    socket.on('message', handleMessage);
    socket.on('rateLimit', console.warn);
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
      default:
        console.error('Invalid View:', view);
        return;
    }
    console.log('Set View:', view);
  }

  /**
   * Handle receiving the server's time.
   * @private
   * @param {number} time The time in milliseconds since epoch.
   */
  function handleTime(time) {
    serverTimeOffset = Date.now() - time;
    console.log(
        'CLOCKS: Server:', time, 'Local:', Date.now(), 'Offset:',
        serverTimeOffset);
  }

  /**
   * Handle new guild data from the server.
   * @private
   * @param {?string} err Possible error that occurred.
   * @param {Object} data Guild data.
   */
  function handleGuilds(err, data) {
    if (err) {
      console.error('Guilds:', err);
      return;
    }
    console.log('Guilds:', data);
    setView('main');
    guilds = Object.values(data);
    if (!guildList) {
      guildList = document.createElement('div');
    } else {
      guildList.innerHTML = '';
    }
    guilds.forEach(function(el) {
      addNewGuild(guildList, el);
    });
    if (!data || data.length === 0) {
      guildList.innerHTML =
          'Invite SpikeyBot to your server to start managing its settings<br>' +
          '<a class="invite" href="https://www.spikeybot.com/invite/" ' +
          'target="_blank">Invite SpikeyBot</a><br><small>Refresh this page ' +
          'once the bot has joined your server.</small>';
    }
    mainBody.innerHTML = '';
    const title = document.createElement('h2');
    title.innerHTML =
        'Mutual Servers with SpikeyBot <a class="invite" href="https://www.' +
        'spikeybot.com/invite/" target="_blank" id="invite">Invite</a>';
    title.style.marginBottom = 0;
    title.style.marginTop = 0;
    title.style.lineHeight = 0.5;
    const subtitle = document.createElement('a');
    subtitle.innerHTML = '<br>Select a server to manage settings';
    subtitle.style.fontWeight = 'normal';
    subtitle.style.fontSize = '0.5em';
    title.appendChild(subtitle);
    if (user.id == '124733888177111041') {
      let gIdInput = document.createElement('input');
      gIdInput.type = 'number';
      gIdInput.oninput = function() {
        console.log(this.value);
        socket.emit('fetchGuild', this.value, function(err, ...args) {
          console.log(args);
          const g = args[0];
          if (!g) return;
          guilds.push(g);
          addNewGuild(guildList, g);
          socket.emit('fetchRaidSettings', g.id, (err, s) => {
            console.log(s);
            if (!s) return;
            if (!settings[g.id]) settings[g.id] = {};
            settings[g.id].raidSettings = s;
          });
          socket.emit('fetchModLogSettings', g.id, (err, s) => {
            console.log(s);
            if (!s) return;
            if (!settings[g.id]) settings[g.id] = {};
            settings[g.id].modLogSettings = s;
          });
          socket.emit('fetchGuildScheduledCommands', g.id, (err, s) => {
            console.log(s);
            if (!s) return;
            if (!settings[g.id]) settings[g.id] = {};
            scheduledCmds[g.id] = s;
          });
        });
      };
      title.appendChild(gIdInput);
    }
    mainBody.appendChild(title);
    mainBody.appendChild(guildList);
    if (guilds.length == 1) {
      selectedGuild = guilds[0].id;
    }
    if (selectedGuild) selectGuild(selectedGuild);
  }
  /**
   * Add a new guild to the list of all guilds.
   * @private
   * @param {HTMLElement} guildList The parent element to add each guild to.
   * @param {Object} el The guild object to add.
   */
  function addNewGuild(guildList, el) {
    const row = document.createElement('p');
    row.id = el.id;
    row.classList.add('guildListRow');
    row.onclick = function() {
      selectGuild(this.id);
    };

    const sIcon = document.createElement('img');
    sIcon.classList.add('guildListIcon');
    sIcon.src =
        (el.iconURL ||
         'https://discord.com/assets/1c8a54f25d101bdc607cec7228247a9a' +
             '.svg') +
        '?size=128';
    row.appendChild(sIcon);

    const sName = document.createElement('a');
    sName.classList.add('guildListName');
    sName.appendChild(document.createTextNode(el.name));
    row.appendChild(sName);

    guildList.appendChild(row);
  }
  /**
   * Handle receiving all settings for a guild.
   * @private
   * @param {?string} err Possible error.
   * @param {Object} data The settings data.
   */
  function handleSettings(err, data) {
    console.log('Raw Settings:', data);
    if (!data) return;
    data.forEach((el) => {
      settings[el.guild] = el;
    });
    console.log('Settings:', settings);

    const prefixInput = document.getElementById('prefixInput');
    if (selectedGuild && settings[selectedGuild] && prefixInput) {
      prefixInput.value = settings[selectedGuild].prefix;
      prefixInput.disabled = false;
    }
    const raidSection = document.getElementById('raidBlockBody');
    if (raidSection) {
      makeNewRaidBlockSection(raidSection);
    }
    const modLogSection = document.getElementById('modLogBody');
    if (modLogSection) {
      makeNewModLogSection(modLogSection);
    }
    const commandsSection = document.getElementById('commandsBody');
    if (commandsSection) {
      makeNewCommandsSection(commandsSection);
    }
  }
  /**
   * Handle a setting being changed on a guild.
   * @private
   * @param {string} gId ID of guild where setting was changed.
   * @param {string} value The setting value.
   * @param {string} type The type of data the setting is.
   * @param {string} id Setting id.
   * @param {string} id2 Second setting id.
   */
  function handleSettingsChanged(gId, value, type, id, id2) {
    console.log('Settings changed in guild', gId, value, type, id, id2);
  }
  /**
   * Handle settings being reset for a guild.
   * @private
   * @param {string} gId ID of guild where settings were reset.
   */
  function handleSettingsReset(gId) {
    console.log('Settings reset in guild', gId);
  }

  /**
   * Handle the raid settings being changed in a guild.
   * @private
   * @param {string} gId ID of the guild where the settings were changed.
   */
  function handleRaidSettingsChanged(gId) {
    console.log('Raid Settings changed in guild', gId);
    clearTimeout(raidSettingsTimeout);
    raidSettingsTimeout = setTimeout(() => {
      if (gId == selectedGuild) {
        socket.emit('fetchRaidSettings', gId, (err, data) => {
          settings[gId].raidSettings = data;
          makeNewRaidBlockSection(document.getElementById('raidBlockBody'));
        });
      }
    }, 500);
  }
  /**
   * Handle the raid settings being changed in a guild.
   * @private
   * @param {string} gId ID of the guild where the settings were changed.
   */
  function handleModLogSettingsChanged(gId) {
    console.log('ModLog Settings changed in guild', gId);
    clearTimeout(modLogSettingsTimeout);
    modLogSettingsTimeout = setTimeout(() => {
      if (gId == selectedGuild) {
        socket.emit('fetchModLogSettings', gId, (err, data) => {
          settings[gId].modLogSettings = data;
          makeNewModLogSection(document.getElementById('modLogBody'));
        });
      }
    }, 500);
  }
  /**
   * Handle the command settings being changed in a guild.
   * @private
   * @param {string} gId ID of the guild where the settings were changed.
   * @param {string} cmd The command the settings were changed for.
   */
  function handleCommandSettingsChanged(gId, cmd) {
    console.log('Command Settings changed in guild', gId, cmd);
    clearTimeout(commandSettingsTimeout);
    commandSettingsTimeout = setTimeout(() => {
      if (gId == selectedGuild) {
        socket.emit('fetchCommandSettings', gId, cmd, (err, data) => {
          settings[gId].commandSettings[cmd] = data;
          const split = cmd.split(' ');
          let sub = {subCmds: settings[gId].commandDefaults};
          while (split.length > 0 && sub.subCmds) {
            sub = sub.subCmds[split.splice(0, 1)[0]];
          }
          const cmdRow = document.getElementById(`${cmd}CommandRow`);
          makeCommandRow(sub, document.getElementById('commandsBody'), cmdRow);
        });
      }
    }, 500);
  }
  /**
   * Handle user requesting prefix to be changed.
   * @private
   * @param {Event} event DOM event.
   */
  function prefixEditHandler(event) {
    console.log(
        'Changing prefix from', settings[selectedGuild].prefix, 'to',
        event.target.value);
    socket.emit(
        'changePrefix', selectedGuild, event.target.value, function(err) {
          event.target.disabled = false;
          if (err) {
            console.error(err);
            event.target.value = event.target.initialValue;
            showMessageBox('Failed to change command prefix: ' + err);
          } else {
            showMessageBox('Prefix changed to ' + event.target.value);
            event.target.initialValue = event.target.value;
          }
        });
    event.target.blur();
    event.target.disabled = true;
  }
  /**
   * Handle receiving the scheduled commands for a guild.
   * @private
   * @param {?string} err Possible error message.
   * @param {Object} data Object of all scheduled commands.
   */
  function handleScheduledCommands(err, data) {
    console.log('Scheduled:', data);
    if (scheduledCmds) {
      for (let i in scheduledCmds) {
        if (!scheduledCmds[i]) continue;
        const cmds = scheduledCmds[i];
        for (let cmd of cmds) {
          if (cmd.timeout) {
            clearTimeout(cmd.timeout);
          }
        }
      }
    }
    for (let i in data) {
      if (!data[i]) continue;
      scheduledCmds[i] = data[i];
    }

    const container = document.getElementById('sCmdsSection');
    if (!container) return;
    while (container.children.length > 3) container.lastChild.remove();
    if (!scheduledCmds[selectedGuild]) return;
    for (let i = 0; i < scheduledCmds[selectedGuild].length; i++) {
      const el = updateScheduledCmdRow(
          scheduledCmds[selectedGuild][i], null, container);
      makeScheduledCommandInterval(
          scheduledCmds[selectedGuild][i], el, container);
    }

    updateChannelOptions();
  }
  /**
   * Handle a new scheduled command being registered to a guild.
   * @private
   * @param {string} gId ID of guild.
   * @param {Object} cmd The command that was registered.
   */
  function handleCommandRegistered(gId, cmd) {
    console.log('Registered:', cmd, gId);
    if (!scheduledCmds[gId]) scheduledCmds[gId] = [];
    scheduledCmds[gId].push(cmd);

    const el = updateScheduledCmdRow(cmd);
    makeScheduledCommandInterval(cmd, el);
    updateChannelOptions();
  }
  /**
   * Handle a scheduled command being cancelled.
   * @private
   * @param {string} gId The guild id.
   * @param {string} cmdId The ID of the scheduled command.
   */
  function handleCommandCancelled(gId, cmdId) {
    console.log('Cancelled:', cmdId, gId);
    if (!scheduledCmds[gId]) return;
    const index = scheduledCmds[gId].findIndex(function(el) {
      return el.id == cmdId;
    });
    if (index < 0) return;
    clearTimeout(scheduledCmds[gId][index].timeout);
    scheduledCmds[gId].splice(index, 1);

    const sCmdRow = document.getElementById(gId + cmdId);
    if (!sCmdRow) return;
    sCmdRow.remove();
  }

  /**
   * Select a guild in the list to show the user.
   * @private
   * @param {string} id The id of the guild to select.
   */
  function selectGuild(id) {
    if (selectedGuild == id) {
      unfoldedElements = document.getElementsByClassName('guildSection');
      if (unfoldedElements && unfoldedElements.length > 0) {
        unfoldedElements = [].slice.call(unfoldedElements)
                               .filter(function(el) {
                                 return !el.classList.contains('folded');
                               })
                               .map(function(el) {
                                 return el.id;
                               });
      } else {
        unfoldedElements = [];
      }
    } else {
      unfoldedElements = [];
    }

    selectedGuild = id;
    mainBody.children[0].classList.add('hidden');
    for (let i in guildList.children) {
      if (typeof guildList.children[i].style === 'undefined') continue;
      if (guildList.children[i].id !== id) {
        guildList.children[i].classList.add('hidden');
      } else {
        guildList.children[i].onclick = unselectGuild;
        guildList.children[i].classList.add('selected');
      }
    }
    guild = guilds.find(function(g) {
      return g.id == id;
    });

    let guildBody = document.getElementById('guildBody');
    if (!guildBody) {
      guildBody = document.createElement('div');
      guildBody.id = 'guildBody';
    } else {
      guildBody.innerHTML = '';
    }
    guildBody.classList.remove('hidden');
    guildBody.classList.add('contentsection');
    guildBody.classList.add('insetcontent');

    const meSection = document.createElement('div');
    const myName = document.createElement('div');
    myName.style.marginBottom = 0;
    myName.style.marginTop = '1.3em';
    myName.style.fontWeight = 'bold';
    myName.appendChild(
        document.createTextNode(
            (guild.myself && guild.myself.nickname) || user.username));
    meSection.appendChild(myName);

    const myRoles = document.createElement('div');
    for (let role of guild.myself.roles) {
      if (role.name === '@everyone') continue;
      const myRole  = document.createElement('a');
      myRole.appendChild(document.createTextNode(role.name));
      if (role.color) {
        myRole.style.background =
            '#' + ('000000' + role.color.toString(16)).slice(-6);
        const color = role.color.toString(16);
        const r = color.substr(0, 2);
        const g = color.substr(2, 2);
        /* var b = color.substr(4, 2); */
        if (r > 'c8' && g > 'c8' /* && b > 'ee' */) {
          myRole.style.color = 'black';
          myRole.style.border = '1px solid black';
        } else {
          myRole.style.color = 'white';
        }
      } else {
        myRole.style.border = '1px solid black';
      }
      myRole.style.margin = '4px';
      myRole.style.borderRadius = '10px';
      myRole.style.padding = '2px';
      myRoles.appendChild(myRole);
    }
    meSection.appendChild(myRoles);

    if (guild.ownerId == guild.myself.user.id) {
      const crown =
          document.createElementNS('http://www.w3.org/2000/svg', 'svg');
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
      const rect =
          document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', '24');
      rect.setAttribute('height', '24');
      g.appendChild(rect);
      crown.appendChild(g);
      myName.appendChild(crown);
    }

    guildBody.appendChild(meSection);

    const prefixSection = document.createElement('div');
    prefixSection.classList.add('member');
    prefixSection.classList.add('guildBodySection');
    prefixSection.id = 'prefixSection';
    const prefixTitle = document.createElement('h2');
    prefixTitle.classList.add('title');
    prefixTitle.innerHTML = 'Command Prefix';
    prefixSection.appendChild(prefixTitle);
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.id = 'prefixInput';
    prefixInput.oninput = function() {
      this.value = this.value.replace(/[\`\s]/g, '');
    };
    prefixInput.onkeyup = function(event) {
      if (event.keyCode === 13) {
        // Enter
        prefixEditHandler(event);
      } else if (event.keyCode == 27) {
        // Escape
        this.value = this.initialValue;
        this.blur();
      }
    };
    if (settings[selectedGuild]) {
      prefixInput.value = settings[selectedGuild].prefix;
      prefixInput.initialValue = prefixInput.value;
    } else {
      prefixInput.disabled = true;  // Disabled until we receive the value.
    }
    prefixSection.appendChild(prefixInput);

    guildBody.appendChild(prefixSection);

    const raidBlockSection = document.createElement('div');
    guildBody.appendChild(raidBlockSection);
    raidBlockSection.classList.add('member');
    raidBlockSection.classList.add('guildBodySection');
    raidBlockSection.id = 'raidBlockSection';
    const raidBlockTitle = document.createElement('h2');
    raidBlockTitle.classList.add('title');
    raidBlockTitle.innerHTML = 'Raid Block';
    raidBlockSection.appendChild(raidBlockTitle);
    const raidBlockBody = document.createElement('div');
    raidBlockBody.id = 'raidBlockBody';
    makeNewRaidBlockSection(raidBlockBody);
    raidBlockSection.appendChild(raidBlockBody);

    const modLogSection = document.createElement('div');
    guildBody.appendChild(modLogSection);
    modLogSection.classList.add('member');
    modLogSection.classList.add('guildBodySection');
    modLogSection.id = 'modLogSection';
    const modLogTitle = document.createElement('h2');
    modLogTitle.classList.add('title');
    modLogTitle.innerHTML = 'Moderator Logging';
    modLogSection.appendChild(modLogTitle);
    const modLogBody = document.createElement('div');
    modLogBody.id = 'modLogBody';
    makeNewModLogSection(modLogBody);
    modLogSection.appendChild(modLogBody);

    const sCmdsSection = document.createElement('div');
    sCmdsSection.classList.add('member');
    sCmdsSection.classList.add('guildBodySection');
    sCmdsSection.id = 'sCmdsSection';
    const sCmdsTitle = document.createElement('h2');
    sCmdsTitle.classList.add('title');
    sCmdsTitle.innerHTML = 'Scheduled Commands';
    sCmdsSection.appendChild(sCmdsTitle);
    const sCmdsSubTitle = document.createElement('h3');
    sCmdsSubTitle.classList.add('subtitle');
    sCmdsSubTitle.classList.add('datetime');
    sCmdsSubTitle.appendChild(
        document.createTextNode(
            fullDateTime(new Date(), {seconds: true, timezone: true})));
    sCmdsSection.appendChild(sCmdsSubTitle);
    const sCmdNew = document.createElement('div');
    sCmdNew.classList.add('folded');
    sCmdNew.classList.add('section');
    const sCmdNewTitle = document.createElement('h4');
    sCmdNewTitle.classList.add('title');
    sCmdNewTitle.appendChild(document.createTextNode('New Command'));
    sCmdNewTitle.href = '#';
    sCmdNewTitle.onclick = function() {
      sCmdNew.classList.toggle('folded');
    };
    sCmdNew.appendChild(sCmdNewTitle);

    const sCmdNewSection = document.createElement('div');
    sCmdNewSection.classList.add('member');
    sCmdNewSection.classList.add('sCmdSection');
    sCmdNewSection.id = 'newSCmdSection';
    makeNewScheduledCommandSection(sCmdNewSection);
    sCmdNew.appendChild(sCmdNewSection);

    sCmdsSection.appendChild(sCmdNew);
    if (scheduledCmds[selectedGuild]) {
      for (let i = 0; i < scheduledCmds[selectedGuild].length; i++) {
        updateScheduledCmdRow(
            scheduledCmds[selectedGuild][i], null, sCmdsSection);
        makeScheduledCommandInterval(
            scheduledCmds[selectedGuild][i], null, sCmdsSection);
      }
    }
    guildBody.appendChild(sCmdsSection);

    const commandsSection = document.createElement('div');
    guildBody.appendChild(commandsSection);
    commandsSection.classList.add('member');
    commandsSection.classList.add('guildBodySection');
    commandsSection.id = 'commandsSection';
    const commandsTitle = document.createElement('h2');
    commandsTitle.classList.add('title');
    commandsTitle.innerHTML = 'Commands Settings';
    commandsSection.appendChild(commandsTitle);
    const commandsBody = document.createElement('div');
    commandsBody.id = 'commandsBody';
    makeNewCommandsSection(commandsBody);
    commandsSection.appendChild(commandsBody);

    mainBody.appendChild(guildBody);

    (function(gId) {
      let numReplies = 0;
      let numTotal = guild.channels.length;
      guild.channels.forEach(function(c) {
        socket.emit('fetchChannel', gId, c, (err, chan) => {
          numReplies++;
          if (!chan) {
            if (numReplies == numTotal) {
              updateChannelOptions();
              console.log('Channels:', channels);
            }
            return;
          }
          if (!channels[gId]) channels[gId] = {};
          channels[gId][chan.id] = chan;
          if (numReplies == numTotal) {
            updateChannelOptions();
            console.log('Channels:', channels);
          }
        });
      });
    })(selectedGuild);

    updateChannelOptions();
  }

  /**
   * Unselect the currently selected guild and show the list of all guilds.
   * @private
   */
  function unselectGuild() {
    if (scheduledCmds[selectedGuild]) {
      for (let i = 0; i < scheduledCmds[selectedGuild].length; i++) {
        clearTimeout(scheduledCmds[selectedGuild][i].timeout);
      }
    }
    selectedGuild = null;
    mainBody.children[0].classList.remove('hidden');
    if (mainBody.children.length > 2) {
      mainBody.children[2].classList.add('hidden');
    }
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
   * Convert the given container into the RaidBlock section.
   * @private
   * @param {HTMLElement} container Container to convert into the section.
   */
  function makeNewRaidBlockSection(container) {
    if (!settings[selectedGuild] || !settings[selectedGuild].raidSettings) {
      container.innerHTML =
          'Unable to manage Raid Block due to internal server error.';
      return;
    } else {
      container.innerHTML = '';
    }
    const s = settings[selectedGuild].raidSettings;
    const enabledContainer = document.createElement('div');
    container.appendChild(enabledContainer);
    enabledContainer.classList.add('raidSettingParent');
    const enabledLabel = document.createElement('label');
    enabledContainer.appendChild(enabledLabel);
    enabledLabel.htmlFor = 'raidEnabledInput';
    enabledLabel.innerHTML = 'Enabled:';
    const enabledInput = document.createElement('input');
    enabledContainer.appendChild(enabledInput);
    enabledInput.type = 'checkbox';
    enabledInput.id = 'raidEnabledInput';
    enabledInput.checked = s.enabled;
    makeCheckboxIntoSwitch(enabledInput);

    const paramsContainer = document.createElement('div');
    container.appendChild(paramsContainer);
    paramsContainer.classList.add('raidSettingParent');
    paramsContainer.id = 'raidParamsContainer';
    const activeIf = document.createElement('a');
    paramsContainer.appendChild(activeIf);
    activeIf.innerHTML = 'Activates if ';

    const numJoinInput = document.createElement('input');
    paramsContainer.appendChild(numJoinInput);
    numJoinInput.type = 'number';
    numJoinInput.id = 'raidNumJoinInput';
    numJoinInput.value = s.numJoin;

    const usersJoin = document.createElement('a');
    paramsContainer.appendChild(usersJoin);
    usersJoin.innerHTML = ' users join within ';

    const timeInput = document.createElement('input');
    paramsContainer.appendChild(timeInput);
    timeInput.type = 'number';
    timeInput.id = 'raidTimeInput';
    timeInput.value = s.timeInterval / 1000;

    const timeUnitInput = document.createElement('select');
    paramsContainer.appendChild(timeUnitInput);
    timeUnitInput.id = 'raidTimeUnitInput';

    const timeUnitSeconds = document.createElement('option');
    timeUnitSeconds.value = 1000;
    timeUnitSeconds.innerHTML = 'seconds';
    timeUnitInput.add(timeUnitSeconds);
    const timeUnitMinutes = document.createElement('option');
    timeUnitMinutes.value = 60000;
    timeUnitMinutes.innerHTML = 'minutes';
    timeUnitInput.add(timeUnitMinutes);
    const timeUnitHours = document.createElement('option');
    timeUnitHours.value = 3600000;
    timeUnitHours.innerHTML = 'hours';
    timeUnitInput.add(timeUnitHours);

    timeUnitInput.selectedIndex = 0;

    const durationContainer = document.createElement('div');
    container.appendChild(durationContainer);
    durationContainer.classList.add('raidSettingParent');
    durationContainer.id = 'raidDurationContainer';

    const durationLabel = document.createElement('label');
    durationContainer.appendChild(durationLabel);
    durationLabel.innerHTML = 'Active for ';
    durationLabel.htmlFor = 'raidDurationInput';

    const durationInput = document.createElement('input');
    durationContainer.appendChild(durationInput);
    durationInput.id = 'raidDurationInput';
    durationInput.type = 'number';
    durationInput.value = s.duration / 1000;

    const durationUnitInput = document.createElement('select');
    durationContainer.appendChild(durationUnitInput);
    durationUnitInput.id = 'raidDurationUnitInput';

    const durationUnitSeconds = document.createElement('option');
    durationUnitSeconds.value = 1000;
    durationUnitSeconds.innerHTML = 'seconds';
    durationUnitInput.add(durationUnitSeconds);
    const durationUnitMinutes = document.createElement('option');
    durationUnitMinutes.value = 60000;
    durationUnitMinutes.innerHTML = 'minutes';
    durationUnitInput.add(durationUnitMinutes);
    const durationUnitHours = document.createElement('option');
    durationUnitHours.value = 3600000;
    durationUnitHours.innerHTML = 'hours';
    durationUnitInput.add(durationUnitHours);

    durationUnitInput.selectedIndex = 0;

    const actionContainer = document.createElement('div');
    container.appendChild(actionContainer);
    actionContainer.classList.add('raidSettingParent');
    actionContainer.id = 'raidActionContainer';
    const actionLabel = document.createElement('label');
    actionContainer.appendChild(actionLabel);
    actionLabel.innerHTML = 'While active ';
    actionLabel.htmlFor = 'raidActionInput';
    const actionInput = document.createElement('select');
    actionContainer.appendChild(actionInput);
    actionInput.id = 'raidActionInput';

    const banSelect = document.createElement('option');
    banSelect.value = 'ban';
    banSelect.innerHTML = 'ban';
    actionInput.add(banSelect);
    const kickSelect = document.createElement('option');
    kickSelect.value = 'kick';
    kickSelect.innerHTML = 'kick';
    actionInput.add(kickSelect);
    const muteSelect = document.createElement('option');
    muteSelect.value = 'mute';
    muteSelect.innerHTML = 'mute';
    actionInput.add(muteSelect);

    setTimeout(() => {
      actionInput.value = s.action;
    });

    const actionPostLabel = document.createElement('a');
    actionContainer.appendChild(actionPostLabel);
    actionPostLabel.innerHTML = ' all new users who join the server.';

    const warnMessageContainer = document.createElement('div');
    container.appendChild(warnMessageContainer);
    warnMessageContainer.classList.add('raidSettingParent');
    const additionallySendDM = document.createElement('label');
    warnMessageContainer.appendChild(additionallySendDM);
    additionallySendDM.innerHTML = 'Additionally send DM to user?';
    additionallySendDM.htmlFor = 'warnMessageCheckbox';
    const warnMessageToggle = document.createElement('input');
    warnMessageContainer.appendChild(warnMessageToggle);
    warnMessageToggle.id = additionallySendDM.htmlFor;
    warnMessageToggle.type = 'checkbox';
    warnMessageToggle.checked = s.sendWarning;
    warnMessageToggle.classList.add('checkbox');
    makeCheckboxIntoSwitch(warnMessageToggle);
    const warnMessageInputContainer = document.createElement('div');
    warnMessageContainer.appendChild(warnMessageInputContainer);
    const warnMessageInput = document.createElement('input');
    warnMessageInputContainer.appendChild(warnMessageInput);
    warnMessageInput.id = 'warnMessageInput';
    warnMessageInput.type = 'text';
    warnMessageInput.value = s.warnMessage;
    warnMessageInput.oninput = function() {
      this.value = this.value.substring(0, 1001);
    };
    const warnMessageLabel = document.createElement('label');
    warnMessageInputContainer.appendChild(warnMessageLabel);
    warnMessageLabel.style.fontSize = '0.8em';
    warnMessageLabel.innerHTML = '<br>';
    let verb = '';
    switch (s.action) {
      case 'kick':
        verb = 'kicked';
        break;
      case 'ban':
        verb = 'banned';
        break;
      case 'mute':
        verb = 'muted';
        break;
    }
    const guild = guilds.find((el) => el.id == selectedGuild);
    const finalMessage = s.warnMessage.replace(/\{action\}/, verb)
                             .replace(/\{server\}/g, guild.name)
                             .replace(/\{username\}/g, user.username);
    warnMessageLabel.appendChild(document.createTextNode(finalMessage));
    warnMessageLabel.htmlFor = warnMessageInput.id;
    if (!warnMessageToggle.checked) {
      warnMessageInputContainer.style.display = 'none';
    }

    const save = function() {
      let numSent = 0;
      let numDone = 0;
      let lastError = null;
      if (enabledInput.checked != s.enabled) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'enabled', enabledInput.checked,
            done);
      }
      if (numJoinInput.value != s.numJoin) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'numJoin', numJoinInput.value,
            done);
      }
      if (timeInput.value * timeUnitInput.value != s.timeInterval) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'timeInterval',
            timeInput.value * timeUnitInput.value, done);
      }
      if (durationInput.value * durationUnitInput.value != s.duration) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'duration',
            durationInput.value * durationUnitInput.value, done);
      }
      if (actionInput.value != s.action) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'action', actionInput.value,
            done);
      }
      if (warnMessageToggle.checked != s.sendWarning) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'sendWarning',
            warnMessageToggle.checked, done);
      }
      if (warnMessageInput.value != s.warnMessage) {
        numSent++;
        socket.emit(
            'changeRaidSetting', selectedGuild, 'warnMessage',
            warnMessageInput.value, done);
      }
      /**
       * Callback when each setting has been changed.
       * @private
       * @param {?string} err Error string from server.
       */
      function done(err) {
        numDone++;
        if (err) lastError = err;
        if (numDone < numSent) return;
        if (!lastError) {
          showMessageBox('Saved settings', 2000);
        } else {
          showMessageBox(lastError);
        }
      }
    };
    warnMessageToggle.onchange = save;
    enabledInput.onchange = save;
    numJoinInput.onchange = save;
    warnMessageInput.onchange = save;
    timeInput.onchange = save;
    durationInput.onchange = save;
    actionInput.onchange = save;
  }
  /**
   * Convert the given container into the RaidBlock section.
   * @private
   * @param {HTMLElement} container Container to convert into the section.
   */
  function makeNewModLogSection(container) {
    if (!settings[selectedGuild] || !settings[selectedGuild].modLogSettings) {
      container.innerHTML =
          'Unable to manage Moderator Logging due to internal server error.';
      return;
    } else {
      container.innerHTML = '';
    }
    const guild = guilds.find((el) => el.id == selectedGuild);
    if (!guild) return;

    const s = settings[selectedGuild].modLogSettings;

    const channelParent = document.createElement('div');
    container.appendChild(channelParent);
    const channelLabel = document.createElement('label');
    channelParent.appendChild(channelLabel);
    channelLabel.htmlFor = 'modLogChannelInput';
    channelLabel.innerHTML = 'Mod Log output channel ';
    const channelInput = document.createElement('select');
    channelParent.appendChild(channelInput);

    const noChannelOption = document.createElement('option');
    channelInput.add(noChannelOption);
    noChannelOption.value = null;
    noChannelOption.classList.add('channelOption');
    noChannelOption.innerHTML = 'DISABLED';

    for (let cId of guild.channels) {
      const channelOption = document.createElement('option');
      channelOption.value = cId;
      channelOption.classList.add('channelOption');
      channelInput.add(channelOption);
      if (!channels[guild.id] || !channels[guild.id][cId]) {
        channelOption.appendChild(document.createTextNode(cId));
      } else {
        const channel = channels[guild.id][cId];
        if (channel.type === 'text') {
          channelOption.appendChild(document.createTextNode(channel.name));
          channelOption.innerHTML = '&#65283;' + channelOption.innerHTML;
        } else if (channel.type === 'category') {
          channelOption.appendChild(document.createTextNode(channel.name));
          channelOption.disabled = true;
          channelOption.style.background = 'darkgrey';
          channelOption.style.fontWeight = 'bolder';
        } else {
          const name = document.createTextNode(channel.name);
          channelOption.appendChild(name);
          channelOption.innerHTML = '&#128266; ' + channelOption.innerHTML;
          channelOption.disabled = true;
          channelOption.style.background = 'grey';
          channelOption.style.color = '#DDD';
        }
      }
    }
    setTimeout(() => {
      channelInput.value = s.channel;
    });
    channelInput.onchange = function() {
      socket.emit(
          'changeModLogSetting', selectedGuild, 'channel', this.value,
          (err) => {
            if (err) {
              showMessageBox(err);
              return;
            }
            showMessageBox('Channel changed to ' + this.value);
          });
    };

    for (let i in s) {
      if (['channel', '_updated'].includes(i)) continue;
      const toggleRow = document.createElement('div');
      container.appendChild(toggleRow);
      toggleRow.classList.add('toggleParent');
      const toggleLabel = document.createElement('label');
      toggleRow.appendChild(toggleLabel);
      toggleLabel.innerHTML = camelToSpaces(i);
      toggleLabel.htmlFor = `mod${i}`;
      const toggleInput = document.createElement('input');
      toggleRow.appendChild(toggleInput);
      toggleInput.id = toggleLabel.htmlFor;
      toggleInput.title = i;
      toggleInput.type = 'checkbox';
      toggleInput.checked = s[i];
      toggleInput.classList.add('checkbox');
      toggleInput.onchange = handleModLogToggle;
      makeCheckboxIntoSwitch(toggleInput);
    }
  }

  /**
   * Handle user changing the checkbox value of a ModLog setting.
   * @private
   */
  function handleModLogToggle() {
    socket.emit(
        'changeModLogSetting', selectedGuild, this.title, this.checked,
        (err) => {
          if (err) showMessageBox(err);
        });
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
   * Create an interval to update the scheduled command UI as the commands are
   * run.
   * @private
   * @param {Object} cmd The scheduled command.
   * @param {HTMLElement} el The element to update when the event fires.
   * @param {HTMLElement} container The container of the element to attach the
   * element to when updated.
   */
  function makeScheduledCommandInterval(cmd, el, container) {
    const now = Date.now();
    if (cmd.time - now < 2 * 7 * 24 * 60 * 60 * 1000) {
      cmd.timeout = setTimeout(function() {
        if (cmd.repeatDelay) {
          cmd.time += cmd.repeatDelay;
          el = updateScheduledCmdRow(cmd, el, container);
          el.classList.add('glow');
          setTimeout(function() {
            el.classList.remove('glow');
          });
          updateChannelOptions();
          makeScheduledCommandInterval(cmd, el, container);
        } else {
          el.remove();
        }
      }, cmd.time - now);
    }
  }

  /**
   * Update a scheduled command row with the current information.
   * @private
   * @param {Object} cmd The scheduled command to update.
   * @param {?HTMLElement} el The element to update, or null to create a new
   * one.
   * @param {HTMLElement} container The parent to el.
   * @return {HTMLElement} The created row.
   */
  function updateScheduledCmdRow(cmd, el, container) {
    if (!el) el = document.getElementById(selectedGuild + cmd.id);
    if (!el && !container) {
      container = document.getElementById('sCmdsSection');
      if (!container) return;
    }
    if (!el && container) {
      el = document.createElement('div');
      el.id = selectedGuild + cmd.id;
      el.classList.add('sCmdSection');
      container.appendChild(el);
    }
    el.value = cmd.time;
    let id = el.getElementsByClassName('cmdIdTitle');
    if (!id || id.length == 0) {
      id = document.createElement('a');
      id.classList.add('cmdIdTitle');
      el.appendChild(id);
    } else {
      id = id[0];
      id.firstChild.remove();
    }
    id.appendChild(document.createTextNode(cmd.id));

    let cmdRow = el.getElementsByClassName('cmdRow');
    if (!cmdRow || cmdRow.length == 0) {
      cmdRow = document.createElement('a');
      cmdRow.classList.add('cmdRow');
      el.appendChild(cmdRow);
    } else {
      cmdRow = cmdRow[0];
      cmdRow.firstChild.remove();
    }
    cmdRow.appendChild(document.createTextNode(cmd.cmd));

    if (el.getElementsByTagName('br').length == 0) {
      el.appendChild(document.createElement('br'));
    }

    let authorCell = el.getElementsByClassName('author');
    if (!authorCell || authorCell.length == 0) {
      authorCell = document.createElement('a');
      authorCell.classList.add('author');
      if (cmd.member && cmd.member.user.id == user.id) {
        authorCell.classList.add('self');
      }
      el.appendChild(authorCell);
    } else {
      authorCell = authorCell[0];
      authorCell.firstChild.remove();
    }
    authorCell.appendChild(document.createTextNode(cmd.member.user.tag));

    let timeCell = el.getElementsByClassName('nextTime');
    if (!timeCell || timeCell.length == 0) {
      timeCell = document.createElement('a');
      timeCell.classList.add('nextTime');
      el.appendChild(timeCell);
    } else {
      timeCell = timeCell[0];
      timeCell.firstChild.remove();
    }
    timeCell.appendChild(
        document.createTextNode(fullDateTime(cmd.time, {seconds: true})));

    let repeatTimeCell = el.getElementsByClassName('repeatTime');
    if (!repeatTimeCell || repeatTimeCell.length == 0) {
      repeatTimeCell = document.createElement('small');
      repeatTimeCell.classList.add('repeatTime');
      el.appendChild(repeatTimeCell);
    } else {
      repeatTimeCell = repeatTimeCell[0];
      repeatTimeCell.firstChild.remove();
    }
    if (cmd.repeatDelay) {
      repeatTimeCell.appendChild(
          document.createTextNode(
              ' (Repeats every ' + formatDelay(cmd.repeatDelay) + ')'));
    } else {
      repeatTimeCell.appendChild(document.createTextNode('Does not repeat'));
    }

    if (el.getElementsByTagName('br').length == 1) {
      el.appendChild(document.createElement('br'));
    }

    let channelCell = el.getElementsByClassName('channelOption');
    if (!channelCell || channelCell.length == 0) {
      channelCell = document.createElement('a');
      channelCell.classList.add('channelOption');
      el.appendChild(channelCell);
    } else {
      channelCell = channelCell[0];
      channelCell.firstChild.remove();
    }
    channelCell.appendChild(document.createTextNode(cmd.channel));
    channelCell.value = cmd.channel;

    let deleteButton = el.getElementsByClassName('delete');
    if (!deleteButton || deleteButton.length == 0) {
      deleteButton = document.createElement('button');
      deleteButton.innerHTML = 'Delete';
      deleteButton.classList.add('delete');
      deleteButton.value = cmd.id;
      deleteButton.onclick = clickDeleteSCmd;
      el.appendChild(deleteButton);
    }

    return el;
  }

  /**
   * Create the section of the UI that shows the scheduled commands.
   * @private
   * @param {HTMLElement} container The element to convert into this section.
   */
  function makeNewScheduledCommandSection(container) {
    container.innerHTML = '';
    const form = document.createElement('form');
    container.appendChild(form);
    const channelInput = document.createElement('select');
    channelInput.id = 'newSCmdChannel';
    for (let i = 0; i < guild.channels.length; i++) {
      const channelOption = document.createElement('option');
      channelOption.classList.add('channelOption');
      channelOption.value = guild.channels[i];
      channelOption.innerHTML = guild.channels[i];
      channelInput.appendChild(channelOption);
    }
    form.appendChild(channelInput);

    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.id = 'newSCmdCommand';
    cmdInput.required = true;
    cmdInput.placeholder = 'Enter command to run here...';
    form.appendChild(cmdInput);

    form.appendChild(document.createElement('br'));

    const timeLabel = document.createElement('label');
    timeLabel.innerHTML = 'When to run the command: ';
    timeLabel.htmlFor = 'newSCmdTime';
    timeLabel.required = true;
    form.appendChild(timeLabel);

    const iSOString =
        new Date(Date.now() - (new Date().getTimezoneOffset() * 60000))
            .toISOString()
            .split('.')[0];
    const timeInput = document.createElement('input');
    timeInput.type = 'datetime-local';
    timeInput.min = iSOString;
    timeInput.value = iSOString;
    timeInput.required = true;
    timeInput.setAttribute('step', '1');
    timeInput.id = 'newSCmdTime';
    form.appendChild(timeInput);

    form.appendChild(document.createElement('br'));

    const repeatText = document.createElement('label');
    repeatText.innerHTML = 'Repeats every ';
    repeatText.htmlFor = 'newSCmdRepeatNum';
    form.appendChild(repeatText);

    const repeatIntervalNumber = document.createElement('input');
    repeatIntervalNumber.type = 'number';
    repeatIntervalNumber.id = 'newSCmdRepeatNum';
    form.appendChild(repeatIntervalNumber);

    const repeatIntervalUnit = document.createElement('select');
    repeatIntervalUnit.id = 'newSCmdRepeatUnit';
    const never = document.createElement('option');
    never.value = 0;
    never.innerHTML = 'Does not repeat';
    repeatIntervalUnit.appendChild(never);
    const seconds = document.createElement('option');
    seconds.value = 1000;
    seconds.innerHTML = 'seconds';
    repeatIntervalUnit.appendChild(seconds);
    const minutes = document.createElement('option');
    minutes.value = 60000;
    minutes.innerHTML = 'minutes';
    repeatIntervalUnit.appendChild(minutes);
    const hours = document.createElement('option');
    hours.value = 3600000;
    hours.innerHTML = 'hours';
    repeatIntervalUnit.appendChild(hours);
    const days = document.createElement('option');
    days.value = 86400000;
    days.innerHTML = 'days';
    repeatIntervalUnit.appendChild(days);
    const weeks = document.createElement('option');
    weeks.value = 604800000;
    weeks.innerHTML = 'weeks';
    repeatIntervalUnit.appendChild(weeks);
    form.appendChild(repeatIntervalUnit);

    form.appendChild(document.createElement('br'));

    const submit = document.createElement('input');
    submit.value = 'Submit';
    submit.classList.add('smaller');
    submit.type = 'submit';
    form.onsubmit = function(e) {
      e.preventDefault();
      const sCmd = {
        cmd: cmdInput.value,
        time: new Date(timeInput.value).getTime(),
        repeatDelay: repeatIntervalNumber.value * repeatIntervalUnit.value,
        channel: channelInput.value,
      };
      console.log('Registering:', sCmd);
      socket.emit(
          'registerScheduledCommand', selectedGuild, sCmd, function(err) {
            if (err) {
              console.error(err);
              showMessageBox(err);
            } else {
              container.parentNode.classList.add('folded');
              makeNewScheduledCommandSection(container);
              updateChannelOptions();
            }
          });
    };
    form.appendChild(submit);
  }

  /**
   * Handle user clicking delete on a scheduled command.
   * @private
   */
  function clickDeleteSCmd() {
    console.log('Cancelling Command', selectedGuild, this.value);
    socket.emit('cancelScheduledCommand', selectedGuild, this.value);
  }

  /**
   * Convert the given container into the commands section.
   * @private
   * @param {HTMLElement} container Container to convert into the section.
   */
  function makeNewCommandsSection(container) {
    if (!settings[selectedGuild]) {
      container.innerHTML = 'Loading commands failed.';
      return;
    }
    container.innerHTML = '';

    if (!settings[selectedGuild].commandDefaults) return;

    const defaults = Object.entries(settings[selectedGuild].commandDefaults);

    if (defaults.length == 0) return;

    defaults.sort((a, b) => {
      if (a[0] > b[0]) return 1;
      if (a[0] < b[0]) return -1;
      return 0;
    });

    for (const cmd in defaults) {
      if (!defaults[cmd]) continue;
      makeCommandRow(defaults[cmd][1], container);
    }
  }

  /**
   * Make a row for the given command.
   * @private
   * @param {Object} cmd The command object.
   * @param {HTMLElement} container The parent container for adding rows.
   * @param {HTMLElement} [row] Existing element to replace.
   */
  function makeCommandRow(cmd, container, row) {
    let expand = false;
    if (!row) {
      row = document.createElement('div');
      container.appendChild(row);
    } else {
      expand = row.getElementsByClassName('commandsOptionContainer').length > 0;
      row.innerHTML = '';
    }
    let name;
    if (cmd.parentName) {
      name = `${cmd.parentName} ${cmd.aliases[0]}`;
    } else {
      name = cmd.aliases[0];
    }
    row.classList.add('commandRow');
    row.id = `${name}CommandRow`;
    const label = document.createElement('label');
    row.appendChild(label);
    label.classList.add('commandLabel');
    label.appendChild(document.createTextNode(name));
    label.htmlFor = `${cmd.parentName} ${cmd.aliases[0]}Command`;
    const checkbox = document.createElement('input');
    row.appendChild(checkbox);
    checkbox.type = 'checkbox';
    checkbox.name = 'commandsCheckbox';
    checkbox.id = label.htmlFor;
    checkbox.classList.add('commandCheckbox');
    checkbox.value = `${cmd.parentName} ${cmd.aliases[0]}`;

    checkbox.onclick = function() {
      if (!this.checked) {
        const optContainer =
            row.getElementsByClassName('commandsOptionContainer')[0];
        optContainer.remove();
        return;
      }
      const optContainer = document.createElement('div');
      row.appendChild(optContainer);
      optContainer.classList.add('commandsOptionContainer');
      if (cmd.aliases.length > 1) {
        const aliases = document.createElement('a');
        optContainer.appendChild(aliases);
        aliases.classList.add('commandAliases');
        aliases.appendChild(document.createTextNode(cmd.aliases.join(', ')));
      }

      const helpLink = document.createElement('a');
      optContainer.appendChild(helpLink);
      helpLink.innerHTML = 'Help Page<br>';
      helpLink.target = '_blank';
      helpLink.href = 'https://www.spikeybot.com/help/#' +
          encodeURIComponent(name.replace(/\s/g, '_'));

      const options =
          settings[selectedGuild].commandSettings[name] || cmd.options;
      const onlyGuild = document.createElement('a');
      optContainer.appendChild(onlyGuild);
      onlyGuild.classList.add('commandOnlyGuild');
      onlyGuild.appendChild(
          document.createTextNode(`Server Only: ${options.validOnlyInGuild}`));

      const defaultDisabledParent = document.createElement('div');
      optContainer.appendChild(defaultDisabledParent);
      const defaultDisabledLabel = document.createElement('label');
      defaultDisabledParent.appendChild(defaultDisabledLabel);
      defaultDisabledLabel.innerHTML = 'Disabled by default: ';
      defaultDisabledLabel.htmlFor = `${name}DefaultDisabled`;
      const defaultDisabledInput = document.createElement('input');
      defaultDisabledParent.appendChild(defaultDisabledInput);
      defaultDisabledInput.type = 'checkbox';
      defaultDisabledInput.id = `${name}DefaultDisabled`;
      defaultDisabledInput.checked = options.defaultDisabled;
      defaultDisabledInput.onchange = function() {
        socket.emit(
            'changeCommandSetting', selectedGuild, name, 'defaultDisabled',
            this.checked, null, null, (err) => {
              if (err) {
                console.error(err);
                showMessageBox(err);
              } else {
                console.log('Toggled', name, 'defaultDisabled', this.checked);
              }
            });
      };

      const isMutedParent = document.createElement('div');
      optContainer.appendChild(isMutedParent);
      const isMutedLabel = document.createElement('label');
      isMutedParent.appendChild(isMutedLabel);
      isMutedLabel.innerHTML = 'Muted on Error: ';
      isMutedLabel.htmlFor = `${name}IsMuted`;
      const isMutedInput = document.createElement('input');
      isMutedParent.appendChild(isMutedInput);
      isMutedInput.type = 'checkbox';
      isMutedInput.id = isMutedLabel.htmlFor;
      isMutedInput.checked = options.isMuted;
      isMutedInput.onchange = function() {
        socket.emit(
            'changeCommandSetting', selectedGuild, name, 'isMuted',
            this.checked, null, null, (err) => {
              if (err) {
                console.error(err);
                showMessageBox(err);
              } else {
                console.log('Toggled', name, 'isMuted', this.checked);
              }
            });
      };

      const list = options.defaultDisabled ? options.enabled : options.disabled;

      if (Object.keys(list.channels).length > 0) {
        const channelParent = document.createElement('div');
        optContainer.appendChild(channelParent);
        const channelLabel = document.createElement('label');
        channelParent.appendChild(channelLabel);
        channelLabel.innerHTML =
            options.defaultDisabled ? 'Enabled in ' : 'Disabled in ';
        const channelListParent = document.createElement('div');
        channelParent.appendChild(channelListParent);
        channelListParent.classList.add('commandChannelList');
        for (const c in list.channels) {
          if (!list.channels[c]) continue;
          const channel = document.createElement('a');
          channelListParent.appendChild(channel);
          channel.classList.add('channelLabel');
          channel.classList.add('channelOption');
          channel.href =
              'https://discord.com/channels/' + selectedGuild + '/' + c;
          channel.value = c;
          channel.textContent = c;
        }
        updateChannelOptions();
      }

      if (Object.keys(list.users).length > 0) {
        const memberParent = document.createElement('div');
        optContainer.appendChild(memberParent);
        const memberLabel = document.createElement('label');
        memberParent.appendChild(memberLabel);
        memberLabel.innerHTML =
            options.defaultDisabled ? 'Enabled for ' : 'Disabled for ';
        const memberListParent = document.createElement('div');
        memberParent.appendChild(memberListParent);
        memberListParent.classList.add('commandChannelList');
        if (!members[selectedGuild]) members[selectedGuild] = {};
        for (const u in list.users) {
          if (!list.users[u]) continue;
          const member = document.createElement('a');
          memberListParent.appendChild(member);
          member.classList.add('memberLabel');
          member.title = u;
          if (members[selectedGuild][u]) {
            member.textContent = members[selectedGuild][u].user.tag;
          } else {
            member.textContent = u;
            const guildId = selectedGuild;
            socket.emit('fetchMember', guildId, u, (err, data) => {
              if (err) {
                console.error('Failed to fetch member:', guildId, u, err);
              } else {
                console.log('Fetched member', guildId, u, data);
                members[selectedGuild][u] = data;
                member.textContent = data.user.tag;
              }
            });
          }
        }
      }
    };

    if (expand) checkbox.click();

    for (const sub in cmd.subCmds) {
      if (!cmd.subCmds[sub]) continue;
      makeCommandRow(cmd.subCmds[sub], container);
    }
  }

  /**
   * Update the channel options as we discover the channel names and
   * information.
   * @private
   */
  function updateChannelOptions() {
    if (!channels[selectedGuild]) return;
    const opts = document.getElementsByClassName('channelOption');
    for (let i = 0; i < opts.length; i++) {
      const channel = channels[selectedGuild][opts[i].value];
      if (!channel) continue;
      if (opts[i].innerHTML.endsWith(channel.name)) continue;
      opts[i].firstChild.remove();
      if (channel.type === 'text') {
        opts[i].appendChild(document.createTextNode(channel.name));
        opts[i].innerHTML = '&#65283;' + opts[i].innerHTML;
        if (opts[i].parentNode.selectedIndex > -1 &&
            opts[i]
                .parentNode.children[opts[i].parentNode.selectedIndex]
                .disabled) {
          opts[i].parentNode.value = channel.id;
        }
      } else if (channel.type === 'voice') {
        const name = document.createTextNode(channel.name);
        opts[i].appendChild(name);
        opts[i].innerHTML = '&#128266; ' + opts[i].innerHTML;
        opts[i].disabled = true;
        opts[i].style.background = 'lightgrey';
      } else {
        opts[i].appendChild(document.createTextNode(channel.name));
        opts[i].disabled = true;
        opts[i].style.background = 'darkgrey';
        opts[i].style.fontWeight = 'bolder';
      }
      if (opts[i].parentNode.tagName == 'SELECT') {
        sortChannelOptions(opts[i].parentNode);
      }
    }
  }

  /**
   * Sort channel options to how they appear in Discord.
   * @private
   * @param {HTMLSelectElement} select The element storing the channel options.
   */
  function sortChannelOptions(select) {
    if (!channels[selectedGuild]) return;
    let sorted = false;
    while (!sorted) {
      sorted = true;
      for (let i = 0; i < select.children.length - 1; i++) {
        const currOpt = select.children[i];
        const nextOpt = select.children[i + 1];
        if (!currOpt.parentNode || !nextOpt.parentNode) continue;
        const currChan = channels[selectedGuild][currOpt.value];
        const nextChan = channels[selectedGuild][nextOpt.value];
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
   * Set a browser cookie value.
   * @private
   * @param {string} name The name of the cookie.
   * @param {string} value The value of the cookie.
   * @param {?Date|string|number} expiresAt Date parsable value for when the
   * cookie should expire.
   * @param {string} [path='/'] The cookie path.
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
   * Fetch the value of a cookie.
   * @private
   * @param {string} name The name of the cookie to fetch.
   * @return {string} Value of the cookie.
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
   * Convert a camelCase string to a Space Separated string.
   * @private
   * @param {string} str Input camelCase string.
   * @return {string} Output Space Separated string.
   */
  function camelToSpaces(str) {
    return str.replace(/([A-Z])/g, ' $1').replace(/^./, function(str) {
      return str.toUpperCase();
    });
  }
  /**
   * Fetch a human readable date and time string.
   * @private
   * @param {?Date|number|string} input Input date parsable by Date.
   * @param {{seconds: boolean, timezone: boolean}} opt Only used if
   * toLocaleTimeString does not support locales.
   * @return {string} Formatted string.
   */
  function fullDateTime(input, opt) {
    let date = input;
    if (!(date instanceof Date)) date = new Date(input);
    if (toLocaleTimeStringSupportsLocales()) {
      return fullDate(date) + ' ' +
          date.toLocaleTimeString(undefined, {timeZoneName: 'short'});
    } else {
      return fullDate(date) + ' ' + date.getHours() + ':' +
          ('0' + date.getMinutes()).slice(-2) +
          (opt.seconds ? (':' + ('0' + date.getSeconds()).slice(-2)) : '') +
          (opt.timezone ? (' ' + getTZOffset(date)) : '');
    }
  }
  /**
   * Fetch the full date as a human readable string.
   * @private
   * @param {?Date|number|string} input Input date parsable by Date.
   * @return {string} Output formatted string.
   */
  function fullDate(input) {
    let date = input;
    if (!(date instanceof Date)) date = new Date(input);
    if (toLocaleTimeStringSupportsLocales()) {
      return date.toLocaleDateString(undefined);
    } else {
      return monthToShort(date.getMonth()) + ' ' + date.getDate() + ' ' +
          date.getFullYear();
    }
  }
  /**
   * Convert a month index to a 3 character string.
   * @private
   * @param {number} m Month index.
   * @return {string} Month string.
   */
  function monthToShort(m) {
    return [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ][m];
  }
  /**
   * Get a formatted timezone offset.
   * @private
   * @param {Date} date Date object to use for getting the timezone.
   * @return {string} Formatted timezone offset string.
   */
  function getTZOffset(date) {
    const offset = date.getTimezoneOffset() / -60 * 100;
    const padded = ('0000' + offset).replace(/-/g, '').slice(-4);
    return (offset > 0 ? '+' : '-') + padded;
  }
  let supportLocals;
  /**
   * Check if converting time to a locale string is supported natively.
   * @private
   * @return {boolean} True if `toLocaleTimeString` is supported, false
   * otherwise.
   */
  function toLocaleTimeStringSupportsLocales() {
    if (supportLocals != null) return supportLocals;
    try {
      new Date().toLocaleTimeString('i');
      supportLocals = false;
    } catch (e) {
      supportLocals = e.name === 'RangeError';
    }
    return supportLocals;
  }
  /**
   * Format a delay in milliseconds to a human readable string.
   * @private
   * @param {number} msecs Number of milliseconds.
   * @return {string} Formatted string.
   */
  function formatDelay(msecs) {
    let output = '';
    let unit = 7 * 24 * 60 * 60 * 1000;
    if (msecs >= unit) {
      let num = Math.floor(msecs / unit);
      output += num + ' week' + (num == 1 ? '' : 's') + ', ';
      msecs -= num * unit;
    }
    unit /= 7;
    if (msecs >= unit) {
      let num = Math.floor(msecs / unit);
      output += num + ' day' + (num == 1 ? '' : 's') + ', ';
      msecs -= num * unit;
    }
    unit /= 24;
    if (msecs >= unit) {
      let num = Math.floor(msecs / unit);
      output += num + ' hour' + (num == 1 ? '' : 's') + ', ';
      msecs -= num * unit;
    }
    unit /= 60;
    if (msecs >= unit) {
      let num = Math.floor(msecs / unit);
      output += num + ' minute' + (num == 1 ? '' : 's') + ', ';
      msecs -= num * unit;
    }
    unit /= 60;
    if (msecs >= unit) {
      let num = Math.round(msecs / unit);
      output += num + ' second' + (num == 1 ? '' : 's') + '';
    }
    return output.replace(/,\s$/, '');
  }

  /**
   * Handle the server sending the user a message to see.
   * @private
   * @param {string} text The text to display.
   */
  function handleMessage(text) {
    showMessageBox(text.replace(/\n/g, '<br>'));
  }
  /**
   * Add new message to queue of message boxes.
   * @public
   * @global
   * @param {string} message The message to display.
   * @param {number} [time=7000] The number of milliseconds to show the message
   * for.
   * @param {boolean} [urgent=true] Should this message cancel a possibly
   * existing message in order to be shown immediately.
   */
  window.showMessageBox = function(message, time = 7000, urgent = true) {
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
   * @global
   */
  window.hideMessageBox = function() {
    clearTimeout(messageBoxTimeout);
    messageBoxWrapperDom.classList.remove('visible');
      clearTimeout(messageBoxClearTimeout);
    messageBoxClearTimeout = setTimeout(clearMessageBox, 500);
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
})();

/**
 * Swap two html elements.
 * @public
 * @global
 * @param {HTMLElement} one First element to swap.
 * @param {HTMLElement} two Second element to swap.
 */
window.swapElements = function(one, two) {
  const temp = document.createElement('div');
  one.parentNode.insertBefore(temp, one);
  two.parentNode.insertBefore(one, two);
  temp.parentNode.insertBefore(two, temp);
  temp.remove();
};
