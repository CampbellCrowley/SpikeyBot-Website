// Copyright 2020 Campbell Crowley. All rights reserved.
// Author: Campbell Crowley (web@campbellcrowley.com)
(function() {
  const patreonStatus = {current: 0, goal: 20000};
  const xhr = new XMLHttpRequest();
  const isDev = location.pathname.startsWith('/dev/');
  const url = window.location.origin + (isDev ? '/dev' : '') +
      '/api/public/patreon-campaign';
  xhr.open('GET', url);
  xhr.setRequestHeader('Content-Type', 'text/json');
  xhr.onload = function() {
    if (xhr.status != 200) {
      console.log(xhr.status, xhr.response);
    } else {
      const parsed = JSON.parse(xhr.responseText);
      console.log(parsed);
      patreonStatus.current = parsed.status.data[0].attributes.pledge_sum;
      const goal = parsed.status.included.filter((el) => el.type == 'goal')
          .sort(
              (a, b) => b.attributes.amount_cents -
                               a.attributes.amount_cents)[0];
      patreonStatus.goal = goal.attributes.amount_cents;
      console.log(patreonStatus);
      document.getElementById('patreonStatus').classList.remove('hidden');
      const progress = document.getElementById('patreonProgress');
      const percent =
          Math.floor(patreonStatus.current / patreonStatus.goal * 100);
      progress.style.width = Math.min(percent, 100) + '%';
      const progressBack = document.getElementById('patreonProgressBack');

      if (window.outerWidth < 700) {
        progressBack.textContent = progress.style.width;
      } else {
        progressBack.textContent = goal.attributes.description.split('.')[0] +
            ': $' + patreonStatus.current / 100.0 + ' / $' +
            Math.floor(patreonStatus.goal / 100.0) + '.00';
      }
    }
  };
  xhr.send();
})();
