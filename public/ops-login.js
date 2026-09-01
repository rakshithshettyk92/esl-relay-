'use strict';

document.getElementById('error').hidden = !new URLSearchParams(location.search).has('error');
