// Copyright 2018-2019 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (web@campbellcrowley.com)

(function() {
  const discordAuthorizeUrl =
      'https://discordapp.com/api/oauth2/authorize?client_id=4442935347204587' +
      '53&redirect_uri=https%3A%2F%2Fwww.spikeybot.com%2Fredirect&response_ty' +
      'pe=code&scope=identify%20guilds';
  const patreonOAuthId =
      'Y1epft4RBjlPd44jGuuhKPp5qKkxSz5ZUiwnKd7hTtjDBtK7DODrQcbibvcSkE-I';
  const patreonOAuthUrl =
      'https://www.patreon.com/oauth2/authorize?response_type=code&client_id=' +
      patreonOAuthId +
      '&redirect_uri=https://www.spikeybot.com/redirect/&scope=users';
  const spotifyOAuthId = '23cfc64be6c64bb089ff4d30b0846af6';
  const spotifyOAuthUrl =
      'https://accounts.spotify.com/authorize?response_type=code&client_id=' +
      spotifyOAuthId +
      '&redirect_uri=https://www.spikeybot.com/redirect/&scope=' +
      'user-read-currently-playing';
  const loginButton = document.getElementById('loginButton');
  const sessionState = document.getElementById('sessionState');
  const mainBody = document.getElementById('mainBody');
  const settingsBody = document.getElementById('settingsBody');
  const settingsContent = document.getElementById('settingsContent');
  const isDev = location.pathname.startsWith('/dev/');
  let code = getCookie('code');
  let patreonCode = null;
  let spotifyCode = null;
  if (getCookie('codeType') == 'Patreon') {
    patreonCode = code;
    code = null;
  } else if (getCookie('codeType') == 'Spotify') {
    spotifyCode = code;
    code = null;
  }
  let session = getCookie('session');
  let socket;
  let user = {};
  let patreonSettingsPerms = {};
  let sbApiToken = null;
  let reqApiToken = false;

  let patreonAccountParent;
  let patreonConnectButton;

  let spotifyAccountParent;
  let spotifyConnectButton;

  window.login = function() {
    setCookie('session', '', 0, isDev ? '/dev/' : undefined);
    // Random state value to ensure no tampering with requests during OAuth
    // sequence. I believe this is random enough for my purposes.
    const state = (isDev ? 'dev/account' : 'account') +
        Math.random(Date.now()) * 10000000000000000;
    setCookie('state', state);
    if (getCookie('state') !== state) {
      console.error('UNABLE TO SET STATE COOKIE FOR LOGGING IN!');
      sessionState.innerHTML = 'Please enable cookies to be able to login.';
    } else {
      window.location.href = discordAuthorizeUrl + '&state=' + state;
    }
  };
  /**
   * Logout the currently signed in user.
   * @private
   */
  function logout() {
    setCookie('codeType', '', 0);
    setCookie('code', '', 0);
    setCookie('session', '', undefined, isDev ? '/dev/' : undefined);
    session = null;
    user = {};
    patreonSettingsPerms = {};
    if (socket) {
      socket.emit('logout');
      socket.close();
      socket = null;
    }
    loginButton.innerHTML = '<span>Login</span>';
    loginButton.setAttribute('onclick', 'login()');
    mainBody.innerHTML = '';
    settingsBody.classList.add('disabled');
  }

  if (code || session) {
    loginButton.innerHTML = '<span>Sign Out</span>';
    loginButton.onclick = logout;
    sessionState.innerHTML = 'Connecting...';
    socket = io('www.spikeybot.com', {
      path: isDev ? '/socket.io/dev/account' : '/socket.io/account',
    });
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
        logout();
      } else {
        console.log('Authorized:', data);
        console.log('Authorized:', data.username);
        setCookie('code', '', 0);
        setCookie('codeType', '', 0);
        setCookie(
            'session', data.sessionId, data.sessionExpirationDate,
            isDev ? '/dev/' : undefined);
        user = data;
        session = data.sessionId;
        sessionState.innerHTML = '';
        sessionState.appendChild(
            document.createTextNode(data.username + '#' + data.discriminator));
        socket.emit('getAccountInfo', handleAccountInfo);
        socket.emit('getUserPerms', handleUserPerms);
      }
    });
    socket.on('disconnect', function(reason) {
      console.log('Socket Disconnect:', reason);
      if (!session) {
        sessionState.innerHTML = 'Disconnected. Signing out.';
        logout();
      } else {
        sessionState.innerHTML = 'Disconnected. Reconnecting...';
        socket.open();
      }
    });
  }

  /**
   * Handler new account information from the server.
   * @private
   * @param {?string} err Error string if one occurred.
   * @param {Object} info The user info.
   */
  function handleAccountInfo(err, info) {
    if (err) {
      console.error('Account Info Error:', err);
      mainBody.innerHTML = 'An error occurred.';
      return;
    }

    // console.log('Account Info: ', info);
    mainBody.innerHTML = '';

    const userInfo = document.createElement('div');
    userInfo.classList.add('infoRow');

    const userTitle = document.createElement('h3');
    userTitle.innerHTML = 'Discord';
    userTitle.style.marginBottom = '0.2em';
    userInfo.appendChild(userTitle);

    const profilePic = document.createElement('img');
    profilePic.src = info.avatarURL;
    profilePic.id = 'profilePic';
    userInfo.appendChild(profilePic);

    const nameAndDate = document.createElement('div');
    nameAndDate.classList.add('infoBox');
    const username = document.createElement('a');
    username.appendChild(document.createTextNode(info.username));
    nameAndDate.appendChild(username);
    const discriminator = document.createElement('a');
    discriminator.appendChild(
        document.createTextNode('#' + info.discriminator));
    nameAndDate.appendChild(discriminator);
    nameAndDate.appendChild(document.createElement('br'));
    const createDateTitle = document.createElement('strong');
    createDateTitle.innerHTML = 'Created At ';
    nameAndDate.appendChild(createDateTitle);
    nameAndDate.appendChild(
        document.createTextNode(fullDateTime(info.createdAt)));
    userInfo.appendChild(nameAndDate);

    if (info.activity) {
      const presence = document.createElement('div');
      presence.classList.add('infoBox');
      const type = document.createElement('a');
      type.style.textTransform = 'capitalize';
      type.appendChild(
          document.createTextNode(info.activity.type.toLowerCase()));
      presence.appendChild(type);
      const name = document.createElement('a');
      name.appendChild(document.createTextNode(' ' + info.activity.name));
      presence.appendChild(name);
      presence.appendChild(document.createElement('br'));
      const since = document.createElement('strong');
      since.innerHTML = 'Since ';
      presence.appendChild(since);
      const sinceDate = document.createElement('a');
      sinceDate.appendChild(
          document.createTextNode(
              fullDateTime(info.activity.timestamps.start)));
      presence.appendChild(sinceDate);
      userInfo.appendChild(presence);
    }

    mainBody.appendChild(userInfo);

    // SB API //

    let horizontalLine = document.createElement('div');
    horizontalLine.classList.add('line');
    mainBody.appendChild(horizontalLine);

    const sbInfo = document.createElement('div');
    sbInfo.classList.add('infoRow');
    const sbTitle = document.createElement('h3');
    sbTitle.innerHTML = 'SpikeyBot API';
    sbTitle.style.marginBottom = '0.2em';
    sbInfo.appendChild(sbTitle);

    const loginDates = document.createElement('div');
    loginDates.classList.add('infoBox');
    const firstWebLogin = document.createElement('strong');
    firstWebLogin.innerHTML = 'First website login: ';
    loginDates.appendChild(firstWebLogin);
    loginDates.appendChild(
        document.createTextNode(fullDateTime(info.firstLogin)));
    loginDates.appendChild(document.createElement('br'));
    const latestWebLogin = document.createElement('strong');
    latestWebLogin.innerHTML = 'Latest account interaction: ';
    loginDates.appendChild(latestWebLogin);
    loginDates.appendChild(
        document.createTextNode(fullDateTime(info.lastLogin)));
    sbInfo.appendChild(loginDates);

    const tokenWarning = document.createElement('a');
    tokenWarning.innerHTML =
        'DO NOT share your token with anyone. This token allows anyone to ' +
        'perform actions as your account.';
    tokenWarning.style.display = 'block';
    sbInfo.appendChild(tokenWarning);

    const tokenInfo = document.createElement('div');
    tokenInfo.classList.add('infoBox');
    const tokenTitle = document.createElement('strong');
    tokenTitle.innerHTML = 'API Token: ';
    tokenInfo.appendChild(tokenTitle);
    const tokenPreview = document.createElement('a');
    tokenPreview.id = 'sbTokenPreview';
    tokenPreview.classList.add('masked');
    tokenPreview.textContent =
        '****************************************************************' +
        '****************************************************************';
    tokenPreview.href = '#';
    const tokenResponse = function(token) {
      if (!token || token.length === 0) {
        sbApiToken = null;
        tokenPreview.textContent = 'No Token Generated';
        tokenPreview.classList.add('visible');
      } else {
        sbApiToken = token;
        tokenPreview.classList.remove('visible');
        tokenPreview.textContent = token;
        setTimeout(() => tokenPreview.onclick());
      }
      tokenPreview.removeAttribute('href');
      tokenPreview.classList.remove('masked');
    };
    tokenPreview.onclick = function() {
      if (sbApiToken) {
        if (document.body.createTextRange) {
          const range = document.body.createTextRange();
          range.moveToElementText(tokenPreview);
          range.select();
        } else if (window.getSelection) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(tokenPreview);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } else if (!reqApiToken) {
        reqApiToken = true;
        socket.emit('fetchApiToken', (err, token) => {
          reqApiToken = false;
          if (err) {
            console.error(err);
            return;
          }
          tokenResponse(token);
        });
      }
    };
    tokenInfo.appendChild(tokenPreview);
    sbInfo.appendChild(tokenInfo);
    sbInfo.appendChild(document.createElement('br'));
    const tokenResetButton = document.createElement('button');
    tokenResetButton.innerHTML = 'Reset Token';
    tokenResetButton.onclick = function() {
      if (reqApiToken) return;
      reqApiToken = true;
      socket.emit('resetApiToken', (err, token) => {
        reqApiToken = false;
        if (err) {
          console.error(err);
          return;
        }
        tokenResponse(token);
      });
    };
    sbInfo.appendChild(tokenResetButton);
    mainBody.appendChild(sbInfo);

    // PATREON //

    horizontalLine = document.createElement('div');
    horizontalLine.classList.add('line');
    mainBody.appendChild(horizontalLine);

    const patreonInfo = document.createElement('div');
    patreonInfo.classList.add('infoRow');
    const patreonTitle = document.createElement('h3');
    patreonTitle.innerHTML = 'Patreon';
    patreonTitle.style.marginBottom = '0.2em';
    patreonInfo.appendChild(patreonTitle);

    const becomePatronParent = document.createElement('div');
    becomePatronParent.style.width = '175px';
    becomePatronParent.style.height = '36px';
    becomePatronParent.style.display = 'inline-block';
    becomePatronParent.style.overflow = 'hidden';
    const becomePatronButton = document.createElement('a');
    becomePatronButton.href = 'https://www.patreon.com/bePatron?u=12105522';
    becomePatronButton.setAttribute(
        'data-patreon-widget-type', 'become-patron-button');
    becomePatronButton.innerHTML = 'Become a Patron!';
    becomePatronButton.id = 'becomePatronButton';
    becomePatronParent.appendChild(becomePatronButton);

    const patreonButtonScript = document.createElement('script');
    patreonButtonScript.src =
        'https://c6.patreon.com/becomePatronButton.bundle.js';
    becomePatronParent.appendChild(patreonButtonScript);
    // <a href="https://www.patreon.com/bePatron?u=12105522"
    // data-patreon-widget-type="become-patron-button">Become a
    // Patron!</a><script async defer
    // src="https://c6.patreon.com/becomePatronButton.bundle.js"></script>
    patreonInfo.appendChild(becomePatronParent);

    const patreonStatus = document.createElement('div');
    patreonStatus.innerHTML = info.patreonId ? 'Connected' : 'Disconnected';
    patreonInfo.appendChild(patreonStatus);

    if (!patreonConnectButton) {
      patreonConnectButton = document.createElement('button');
    }
    if (info.patreonId) {
      patreonConnectButton.innerHTML = 'Disconnect';
      patreonConnectButton.href = '#';
      patreonConnectButton.classList.add('red');
      patreonConnectButton.classList.add('clickable');
      patreonConnectButton.classList.remove('green');
      patreonConnectButton.onclick = disconnectPatreon;
    } else if (patreonCode) {
      patreonConnectButton.innerHTML = 'Connecting...';
      patreonConnectButton.href = '';
      patreonConnectButton.classList.remove('green');
      patreonConnectButton.classList.remove('clickable');
      patreonConnectButton.classList.remove('red');
      patreonConnectButton.onclick = undefined;

      finishConnectPatreon(patreonCode, info);
      return;
    } else {
      patreonConnectButton.innerHTML = 'Connect';
      patreonConnectButton.href = '#';
      patreonConnectButton.classList.add('green');
      patreonConnectButton.classList.add('clickable');
      patreonConnectButton.classList.remove('red');
      patreonConnectButton.onclick = connectPatreon;
    }

    patreonInfo.appendChild(patreonConnectButton);

    if (!patreonAccountParent) {
      patreonAccountParent = document.createElement('div');
    } else {
      patreonAccountParent.innerHTML = '';
    }
    patreonInfo.appendChild(patreonAccountParent);

    if (info.patreonId) {
      const patreonAccountId = document.createElement('a');
      patreonAccountId.classList.add('infoBox');
      const idTitle = document.createElement('strong');
      idTitle.innerHTML = 'ID: ';
      patreonAccountId.appendChild(idTitle);
      patreonAccountId.appendChild(document.createTextNode(info.patreonId));
      patreonAccountParent.appendChild(patreonAccountId);

      if (info.patreon) {
        const p = info.patreon;
        const nameAndEmail = document.createElement('div');
        nameAndEmail.classList.add('infoBox');

        const patreonAccountName = document.createElement('a');
        const nameTitle = document.createElement('strong');
        nameTitle.innerHTML = 'Name: ';
        patreonAccountName.appendChild(nameTitle);
        patreonAccountName.appendChild(document.createTextNode(p.fullName));
        nameAndEmail.appendChild(patreonAccountName);

        nameAndEmail.appendChild(document.createElement('br'));

        const patreonAccountEmail = document.createElement('a');
        const emailTitle = document.createElement('strong');
        emailTitle.innerHTML = 'Email: ';
        patreonAccountEmail.appendChild(emailTitle);
        patreonAccountEmail.appendChild(document.createTextNode(p.email));
        nameAndEmail.appendChild(patreonAccountEmail);

        patreonAccountParent.appendChild(nameAndEmail);

        const patreonAccountFirstPledgeDate = document.createElement('a');
        patreonAccountFirstPledgeDate.classList.add('infoBox');
        const dateTitle = document.createElement('strong');
        dateTitle.innerHTML = 'First Pledge Date: ';
        patreonAccountFirstPledgeDate.appendChild(dateTitle);
        patreonAccountFirstPledgeDate.appendChild(
            document.createTextNode(fullDateTime(p.firstPledgeDate)));
        patreonAccountParent.appendChild(patreonAccountFirstPledgeDate);


        const pledgeParent = document.createElement('div');
        pledgeParent.classList.add('infoBox');
        const patreonAccountPledgeAmount = document.createElement('a');
        const pledgeAmountTitle = document.createElement('strong');
        pledgeAmountTitle.innerHTML = 'Pledge Amount: ';
        patreonAccountPledgeAmount.appendChild(pledgeAmountTitle);
        patreonAccountPledgeAmount.appendChild(
            document.createTextNode('$' + ((p.pledge || 0) / 100)));
        pledgeParent.appendChild(patreonAccountPledgeAmount);

        pledgeParent.appendChild(document.createElement('br'));

        const patreonAccountDeclined = document.createElement('a');
        const declinedTitle = document.createElement('strong');
        declinedTitle.innerHTML = 'Payment Declined? ';
        patreonAccountDeclined.appendChild(declinedTitle);
        if (p.decline == '0') p.decline = null;
        patreonAccountDeclined.appendChild(
            document.createTextNode(p.decline || 'No'));
        pledgeParent.appendChild(patreonAccountDeclined);
        patreonAccountParent.appendChild(pledgeParent);
      }
    }
    mainBody.appendChild(patreonInfo);

    // SPOTIFY //

    horizontalLine = document.createElement('div');
    horizontalLine.classList.add('line');
    mainBody.appendChild(horizontalLine);

    const spotifyInfo = document.createElement('div');
    spotifyInfo.classList.add('infoRow');
    const spotifyTitle = document.createElement('h3');
    spotifyTitle.innerHTML = 'Spotify';
    spotifyTitle.style.marginBottom = '0.2em';
    spotifyInfo.appendChild(spotifyTitle);

    const spotifyStatus = document.createElement('div');
    spotifyStatus.innerHTML = info.spotifyId ? 'Connected' : 'Disconnected';
    spotifyInfo.appendChild(spotifyStatus);

    if (!spotifyConnectButton) {
      spotifyConnectButton = document.createElement('button');
    }
    if (info.spotifyId && info.spotify.haveToken) {
      spotifyConnectButton.innerHTML = 'Disconnect';
      spotifyConnectButton.href = '#';
      spotifyConnectButton.classList.add('red');
      spotifyConnectButton.classList.add('clickable');
      spotifyConnectButton.classList.remove('green');
      spotifyConnectButton.onclick = disconnectSpotify;
    } else if (spotifyCode) {
      spotifyConnectButton.innerHTML = 'Connecting...';
      spotifyConnectButton.href = '';
      spotifyConnectButton.classList.remove('green');
      spotifyConnectButton.classList.remove('clickable');
      spotifyConnectButton.classList.remove('red');
      spotifyConnectButton.onclick = undefined;

      finishConnectSpotify(spotifyCode, info);
      return;
    } else {
      spotifyConnectButton.innerHTML = 'Connect';
      spotifyConnectButton.href = '#';
      spotifyConnectButton.classList.add('green');
      spotifyConnectButton.classList.add('clickable');
      spotifyConnectButton.classList.remove('red');
      spotifyConnectButton.onclick = connectSpotify;
    }

    spotifyInfo.appendChild(spotifyConnectButton);

    if (!spotifyAccountParent) {
      spotifyAccountParent = document.createElement('div');
    } else {
      spotifyAccountParent.innerHTML = '';
    }
    spotifyInfo.appendChild(spotifyAccountParent);

    if (info.spotifyId && info.spotify.haveToken) {
      const spotifyAccountId = document.createElement('a');
      spotifyAccountId.classList.add('infoBox');
      const idTitle = document.createElement('strong');
      idTitle.innerHTML = 'ID: ';
      spotifyAccountId.appendChild(idTitle);
      spotifyAccountId.appendChild(document.createTextNode(info.spotifyId));
      spotifyAccountParent.appendChild(spotifyAccountId);

      if (info.spotify) {
        const s = info.spotify;
        const name = document.createElement('div');
        name.classList.add('infoBox');

        const spotifyAccountName = document.createElement('a');
        const nameTitle = document.createElement('strong');
        nameTitle.innerHTML = 'Name: ';
        spotifyAccountName.appendChild(nameTitle);
        spotifyAccountName.appendChild(document.createTextNode(s.name));
        name.appendChild(spotifyAccountName);
        spotifyAccountParent.appendChild(name);
      }
    }
    mainBody.appendChild(spotifyInfo);

    const horizontalLine3 = document.createElement('div');
    horizontalLine3.classList.add('line');
    mainBody.appendChild(horizontalLine3);

    const howToDelete = document.createElement('div');
    howToDelete.classList.add('infoRow');
    howToDelete.innerHTML =
        'If you wish to delete any of your data please send an email to ' +
        '<a href="mailto:web@spikeybot.com">web@spikeybot.com</a>.' +
        '<br>This cannot be undone.';
    mainBody.appendChild(howToDelete);
  }

  /**
   * Handler new permissions information about the user.
   * @private
   * @param {?string} err The error string if there was an error.
   * @param {Object} perms The user's permissions.
   */
  function handleUserPerms(err, perms) {
    console.log('UserPerms:', err, perms);
    patreonSettingsPerms = {};
    if (!err) {
      for (let i = 0; i < perms.status.length; i++) {
        patreonSettingsPerms[perms.status[i]] = true;
      }
      document.getElementById('settingsLimitedText').classList.add('hidden');
    } else {
      document.getElementById('settingsLimitedText').classList.remove('hidden');
    }
    socket.emit('getSettingsTemplate', handleSettingsTemplate);
  }
  /**
   * Handle receiving the template for all settings.
   * @private
   * @param {Object} template The settings template information.
   */
  function handleSettingsTemplate(template) {
    console.log('Template:', template);
    settingsContent.innerHTML = '';

    let entries = Object.entries(template);
    for (let i = 0; i < entries.length; i++) {
      let newSetting = document.createElement('div');
      newSetting.classList.add('settingRow');
      newSetting.id = entries[i][0];
      makeSettingRow(entries[i], newSetting);
      settingsContent.appendChild(newSetting);
    }
    socket.emit('getUserSettings', handleUserSettings);
  }

  /**
   * Make a new setting input for the given setting entries. Appends it to the
   * given Element.
   * @private
   * @param {{0: string, 1: Object}} ent Setting entry.
   * @param {HTMLElement} newSetting Element to append setting input to.
   */
  function makeSettingRow(ent, newSetting) {
    if (ent[1].type === 'select') {
      let title = document.createElement('h4');
      title.classList.add('settingRowTitle');
      title.appendChild(
          document.createTextNode(ent[1].title || ent[0]));
      newSetting.appendChild(title);
      for (let j = 0; j < ent[1].values.length; j++) {
        let newButton = document.createElement('button');
        newButton.classList.add('settingButtons');
        newButton.classList.add('button');
        if (ent[1].values[j] === ent[1].default) {
          newButton.classList.add('selected');
        }
        if (ent[1].hrValues) {
          newButton.innerHTML = ent[1].hrValues[j];
        } else {
          newButton.innerHTML = ent[1].values[j];
        }
        newButton.value = ent[1].values[j];
        newButton.onclick = handleSettingButtonClick;
        newSetting.appendChild(newButton);
      }
    } else if (ent[1].type === 'color') {
      let title = document.createElement('h4');
      title.classList.add('settingRowTitle');
      title.appendChild(
          document.createTextNode(ent[1].title || ent[0]));
      newSetting.appendChild(title);
      let colorInput = document.createElement('input');
      colorInput.classList.add('settingColorInput');
      colorInput.type = 'color';
      let value = ent[1].default;
      if (value * 1 > 0xFFFFFFFF || value * 1 < 0x0 || isNaN(value * 1)) {
        value = '0xF96854FF';
      }
      colorInput.value = '#' + value.slice(2, 8);
      colorInput.onchange = handleSettingColorChange;
      newSetting.appendChild(colorInput);
    } else if (ent[1].type == 'text') {
      let title = document.createElement('h4');
      title.classList.add('settingRowTitle');
      title.appendChild(
          document.createTextNode(ent[1].title || ent[0]));
      newSetting.appendChild(title);
      let textInput = document.createElement('input');
      textInput.classList.add('settingTextInput');
      textInput.type = 'text';
      textInput.value = ent[1].default;
      textInput.oninput = function() {
        this.value = this.value.replace(/`/g, '')
                         .replace(/\s{1,}/g, ' ')
                         .substring(0, 16);
      };
      textInput.onchange = function() {
        this.value = this.value.replace(/`/g, '')
                         .replace(/\s{1,}/g, ' ')
                         .substring(0, 16);
        if (this.value.length == 0) this.value = ent[1].default;
        handleSettingTextChange();
      };
      newSetting.appendChild(textInput);
    } else if (ent[1].type == 'object') {
      let title = document.createElement('h4');
      title.classList.add('settingRowTitle');
      title.appendChild(document.createTextNode(ent[1].title || ent[0]));
      newSetting.appendChild(title);

      const childEnt = Object.entries(ent[1].values);
      for (let i = 0; i < childEnt.length; i++) {
        let child = document.createElement('div');
        child.id = newSetting.id + ' ' + childEnt[i][0];
        child.style.fontSize = '0.9em';
        newSetting.appendChild(child);

        makeSettingRow(childEnt[i], child);
      }
    } else if (ent[1].type == 'boolean') {
      newSetting.classList.add('settingBooleanParent');
      const obj = [
        ent[0],
        {
          type: 'select',
          title: ent[1].title,
          default: ent[1].default,
          values: ['true', 'false'],
          hrValues: ['True', 'False'],
        },
      ];
      makeSettingRow(obj, newSetting);
    } else {
      newSetting.appendChild(
          document.createTextNode(ent[0] + ' (Coming Soon)'));
    }
    if (!patreonSettingsPerms[ent[0]]) {
      newSetting.style.backgroundColor = 'lightgray';
    }
  }
  /**
   * Handle receiving the settings set by the current user.
   * @private
   * @param {?string} err Error string.
   * @param {Object} obj The settings object of all user settings.
   */
  function handleUserSettings(err, obj) {
    console.log('UserSettings:', obj);
    settingsBody.classList.remove('disabled');
    if (err) {
      console.error(err);
      return;
    }
    let entries = Object.entries(obj);
    for (let i = 0; i < entries.length; i++) {
      let setting = entries[i][0];
      let el = document.getElementById(setting);
      if (!el) continue;
      let value = entries[i][1];
      let children = el.children;
      for (let j = 0; j < children.length; j++) {
        if (children[j].type == 'color') {
          if (value * 1 > 0xFFFFFFFF || value * 1 < 0x0 || isNaN(value * 1)) {
            value = '0xF96854FF';
          }
          children[j].value = `#${value.slice(2, 8)}`;
        } else if (children[j].tagName == 'BUTTON') {
          children[j].classList.toggle('selected', children[j].value == value);
        }
      }
    }
  }
  /**
   * Handle a setting value being changed by the user.
   * @private
   */
  function handleSettingButtonClick() {
    let setting = this.parentNode.id;
    let value = this.value;
    let children = this.parentNode.children;
    socket.emit('changeSetting', setting, value, function(err, info) {
      if (err) {
        console.error(setting, value, err, info);
        return;
      }
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle('selected', children[i].value == value);
      }
    });
  }
  /**
   * Handle a setting value being changed by the user.
   * @private
   */
  function handleSettingColorChange() {
    let setting = this.parentNode.id;
    let value = '0x' + this.value.slice(1);
    console.log(setting, value);
    socket.emit('changeSetting', setting, value, function(err, info) {
      if (err) {
        console.error(setting, value, err, info);
        return;
      }
    });
  }
  /**
   * Handle a setting value being changed by the user.
   * @private
   */
  function handleSettingTextChange() {
    const setting = this.parentNode.id;
    const value = this.value;
    console.log(setting, value);
    socket.emit('changeSetting', setting, value, function(err, info) {
      if (err) {
        console.error(setting, value, err, info);
        return;
      }
    });
  }
  /**
   * Begin the OAuth2 login with Patreon.
   * @private
   */
  function connectPatreon() {
    // Random state value to ensure no tampering with requests during OAuth
    // sequence. I believe this is random enough for my purposes.
    const state = (isDev ? 'dev/account' : 'account') + user.id +
        Math.random(Date.now()) * 10000000000000000;
    setCookie('state', state, Date.now() + 5 * 60 * 1000);
    setCookie('codeType', 'Patreon', Date.now() + 5 * 60 * 1000);
    if (getCookie('state') != state) {
      console.error('UNABLE TO SET STATE COOKIE FOR LOGGING IN!');
      sessionState.innerHTML = 'Please enable cookies to be able to login.';
    } else {
      window.location = patreonOAuthUrl + '&state=' + state;
    }
  }
  /**
   * Begin the OAuth2 login with Spotify.
   * @private
   */
  function connectSpotify() {
    // Random state value to ensure no tampering with requests during OAuth
    // sequence. I believe this is random enough for my purposes.
    const state = (isDev ? 'dev/account' : 'account') + user.id +
        Math.random(Date.now()) * 10000000000000000;
    setCookie('state', state, Date.now() + 5 * 60 * 1000);
    setCookie('codeType', 'Spotify', Date.now() + 5 * 60 * 1000);
    if (getCookie('state') != state) {
      console.error('UNABLE TO SET STATE COOKIE FOR LOGGING IN!');
      sessionState.innerHTML = 'Please enable cookies to be able to login.';
    } else {
      window.location = spotifyOAuthUrl + '&state=' + state;
    }
  }
  /**
   * Send the received code from Patreon to the server in order to complete the
   * OAuth2 login.
   * @private
   * @param {string|number} code The code from Patreon's OAuth2 login.
   * @param {Object} obj The current user's account information for use of
   * refreshing the UI if an error occurred.
   */
  function finishConnectPatreon(code, obj) {
    patreonCode = null;
    if (!code) return;
    socket.emit('linkPatreon', code, function(err) {
      if (!err) {
        socket.emit('getAccountInfo', handleAccountInfo);
      } else {
        handleAccountInfo(null, obj);
        console.error(err);
      }
    });
  }
  /**
   * Send the received code from Spotify to the server to complete the OAuth2
   * login.
   * @private
   * @param {string|number} code The code from Spotify's OAuth2 login.
   * @param {Object} obj The current user's account information for user of
   * refreshing the UI if an error occurred.
   */
  function finishConnectSpotify(code, obj) {
    spotifyCode = null;
    if (!code) return;
    socket.emit('linkSpotify', code, function(err) {
      if (!err) {
        socket.emit('getAccountInfo', handleAccountInfo);
      } else {
        handleAccountInfo(null, obj);
        console.error(err);
      }
    });
  }
  /**
   * Unlink the user's Discord account from Patreon.
   * @private
   */
  function disconnectPatreon() {
    socket.emit('unlinkPatreon', function(err) {
      if (!err) {
        socket.emit('getAccountInfo', handleAccountInfo);
      } else {
        console.error(err);
      }
    });

    patreonAccountParent.style.display = 'none';
    patreonConnectButton.innerHTML = 'Disonnecting...';
    patreonConnectButton.href = '';
    patreonConnectButton.classList.remove('green');
    patreonConnectButton.classList.remove('clickable');
    patreonConnectButton.classList.remove('red');
    patreonConnectButton.onclick = undefined;
  }
  /**
   * Unlink the user's account from Spotify.
   * @private
   */
  function disconnectSpotify() {
    socket.emit('unlinkSpotify', function(err) {
      if (!err) {
        socket.emit('getAccountInfo', handleAccountInfo);
      } else {
        console.error(err);
      }
    });

    spotifyAccountParent.style.display = 'none';
    spotifyConnectButton.innerHTML = 'Disonnecting...';
    spotifyConnectButton.href = '';
    spotifyConnectButton.classList.remove('green');
    spotifyConnectButton.classList.remove('clickable');
    spotifyConnectButton.classList.remove('red');
    spotifyConnectButton.onclick = undefined;
  }
  /**
   * Set a browser's cookie.
   * @private
   * @param {string} name The name of the cookie.
   * @param {string} value The value to set.
   * @param {*} [expiresAt] The date to pass into Date at which the cookie will
   * expire.
   * @param {string} [path=/] The path value of the cookie.
   */
  function setCookie(name, value, expiresAt, path = '/') {
    if (expiresAt) {
      let d = new Date(expiresAt);
      let expires = 'expires=' + d.toUTCString();
      document.cookie =
          name + '=' + value + ';' + expires + ';path=' + path + ';secure';
    } else {
      document.cookie = name + '=' + value + ';path=' + path + ';secure';
    }
  }
  /**
   * Get the value of a cookie.
   * @private
   * @param {string} name The name of the cookie to fetch.
   * @return {?string} The cookie's value.
   */
  function getCookie(name) {
    name += '=';
    let decodedCookie = decodeURIComponent(document.cookie);
    let ca = decodedCookie.split(';');
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
   * Convert a camelcase string to a human-readable format. (helloWorld -->
   * Hello World)
   * @private
   * @param {string} str Input camelcase.
   * @return {string} Output Spaces Format.
   */
  /* function camelToSpaces(str) {
    return str.replace(/([A-Z])/g, ' $1').replace(/^./, function(str) {
      return str.toUpperCase();
    });
  } */
  /**
   * Convert a date to a human readable date and time.
   * @private
   * @param {*} input The input into Date.
   * @return {string} The output formatted date and time.
   */
  function fullDateTime(input) {
    let date = new Date(input);
    return monthToShort(date.getMonth()) + ' ' + date.getDate() + ' ' +
        date.getFullYear() + ' ' + date.getHours() + ':' +
        ('0' + date.getMinutes()).slice(-2) + ' ' + getTZOffset(date);
  }
  /**
   * Convert a month index to 3 character string. (0 = Jan, 11 = Dec)
   * @private
   * @param {number} m The month index.
   * @return {string} 3 character string representing a month.
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
   * Get the timezone offset of a date and format it as a string in hours.
   * @private
   * @param {Date} date The date to use to get the TZ offset.
   * @return {string} The formatted timezone offset.
   */
  function getTZOffset(date) {
    let offset = date.getTimezoneOffset() / -60 * 100;
    let padded = ('0000' + offset).replace(/-/g, '').slice(-4);
    return (offset > 0 ? '+' : '-') + padded;
  }
})();
