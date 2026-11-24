/**
 * Shared API client.
 *
 * Keeps the signed session token in localStorage and attaches it as a Bearer
 * header to every same-origin /api request. Existing page code can keep using
 * plain fetch() without any changes.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'knowASpotToken';
  var nativeFetch = window.fetch.bind(window);

  function getAuthToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setAuthToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  window.getAuthToken = getAuthToken;
  window.setAuthToken = setAuthToken;

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/\/api(?:\/|$)/.test(url)) return nativeFetch(input, init);

    var token = getAuthToken();
    var options = init;
    if (token) {
      var headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
      options = Object.assign({}, init, { headers: headers });
    }

    return nativeFetch(input, options).then(function (response) {
      if (response.status === 401 && token) setAuthToken(null);
      return response;
    });
  };
})();
