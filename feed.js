// feed.js • Field Notes social discovery module for "bro said he knows a spot"
// ------------------------------------------------------------------
// Every value rendered here comes from the platform API. There is no
// fabricated feed content: no seeded destinations, no hardcoded trending
// tags, no placeholder counters. Empty states say so explicitly.

// Note: sosEngine.js declares a global `var isFileProtocol`, so this module
// uses its own prefixed name to avoid a global redeclaration error.
const feedIsFileProtocol = window.location.protocol === 'file:';
const API_URL = feedIsFileProtocol
  ? 'http://localhost:3000/api'
  : (window.location.origin.includes(':') && !window.location.origin.endsWith(':3000')
      ? window.location.origin.replace(/:[0-9]+$/, ':3000') + '/api'
      : (window.location.origin + '/api'));

// Cache key is versioned so previously cached data is never reused blindly.
const HIDDEN_POSTS_KEY = 'hidden_post_ids';
// Remove post caches created by older versions; MongoDB is the only content store.
localStorage.removeItem('cached_posts_v4');
localStorage.removeItem('offline_posts');

// --- Session -------------------------------------------------------------
localStorage.removeItem('currentUser');
let currentUser = (() => {
  try { return JSON.parse(sessionStorage.getItem('currentUser') || 'null'); }
  catch (err) { sessionStorage.removeItem('currentUser'); if (window.setAuthToken) window.setAuthToken(null); return null; }
})();
let isGuest = !currentUser || !currentUser.username || !currentUser.id || String(currentUser.id) === '0';

// --- Feed state ----------------------------------------------------------
let allPosts = [];
let stories = [];
let notifications = [];
let dmThreads = [];
let dmThreadsLoadedForUserId = null;
let dmThreadsLoadedAt = 0;
let dmThreadsRequest = null;
let pendingProfileAvatar = '';
let activeDMPeer = null;
let currentFilter = 'all';
let currentView = 'home';
let searchQuery = '';
let renderLimit = 12;
let lastFilteredCount = 0;

let activeStoryIndex = 0;
let storyTimer = null;
let storyIsPaused = false;
let currentWizardStep = 1;
const totalWizardSteps = 4;
let base64MediaList = [];
let activeFilterCss = 'none';
let activePostMenuId = null;
let activeSharePostId = null;
let activeCommentModalPostId = null;
let viewedUserProfile = null;
let reelsObserver = null;

// ============================================================
// Boot
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Start account hydration in parallel. A profile read does not need to block
  // navigation or feed controls while MongoDB prepares the first feed response.
  const profileReady = syncSession();
  initUserProfile();
  initSidebarNavigation();
  initStories();
  initSearch();
  initCreatePostWizard();
  initDirectMessages();
  initAiTrustModal();
  initModals();
  initNotificationsDrawer();
  initProfileModal();
  initShareModal();
  initCommentsModal();
  initEditProfileModal();
  initSosDistress();
  initAuthPromptModal();

  loadPosts();
  loadSuggestions();
  loadTrending();
  loadDestinations();
  loadNotifications();

  profileReady.then(() => initUserProfile());

  // Infinite scroll — the feed loads the next batch as you reach the end.
  window.addEventListener('scroll', () => {
    if (currentView !== 'home') return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 900) {
      if (renderLimit < lastFilteredCount) {
        renderLimit += 12;
        renderFeed(searchQuery);
      }
    }
  });

  // Keyboard accessibility: ESC closes active modals & drawers
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllActiveModals();
  });

  handleDeepLink();
});

// Keep the browser session and the platform user record aligned so that
// likes, comments, saves and messages attach to a real account.
async function syncSession() {
  if (!currentUser || !currentUser.username) {
    currentUser = {
      id: 0,
      name: 'Guest Explorer',
      username: 'guest_traveler',
      role: 'normal',
      is_verified_pro: false,
      avatar: '',
      bio: '',
      vibes: []
    };
    isGuest = true;
    return;
  }

  isGuest = !currentUser.id || String(currentUser.id) === '0' || currentUser.username === 'guest_traveler';

  try {
    const synced = await api(`/users/profile?username=${encodeURIComponent(currentUser.username)}`);
    if (synced) {
      currentUser = { ...currentUser, ...synced };
      sessionStorage.setItem('currentUser', JSON.stringify({ id: currentUser.id, username: currentUser.username }));
    }
  } catch (err) {
    if (err.status === 404) {
      sessionStorage.removeItem('currentUser');
      if (window.setAuthToken) window.setAuthToken(null);
      currentUser = {
        id: 0,
        name: 'Guest Explorer',
        username: 'guest_traveler',
        role: 'normal',
        is_verified_pro: false,
        avatar: '',
        bio: '',
        vibes: []
      };
      isGuest = true;
      return;
    }
    console.warn('Session sync failed, continuing with local session:', err);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function closeAllActiveModals() {
  closeStoryViewer();
  closeCreateModal();
  const sheet = document.getElementById('postActionSheet');
  if (sheet) sheet.classList.add('hidden');
  ['trustPolicyModal', 'aiTrustModal', 'storyCreateModal', 'creatorProfileModal',
   'sharePostModal', 'commentsModal', 'editProfileModal', 'authPromptModal']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
    });
  const notifDrawer = document.getElementById('notificationsDrawer');
  if (notifDrawer) notifDrawer.classList.remove('open');
  const searchDrawer = document.getElementById('searchDrawer');
  if (searchDrawer) searchDrawer.classList.remove('open');
}

// ============================================================
// Account gate — every account action goes through this
// ============================================================
function requireAuth(actionLabel) {
  if (!isGuest) return true;
  openAuthPrompt(actionLabel);
  return false;
}

function initAuthPromptModal() {
  const modal = document.getElementById('authPromptModal');
  if (!modal) return;
  const dismiss = document.getElementById('authPromptDismissBtn');
  if (dismiss) {
    dismiss.onclick = () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    };
  }
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  });
}

function openAuthPrompt(actionLabel) {
  const modal = document.getElementById('authPromptModal');
  if (!modal) return;
  const msg = document.getElementById('authPromptMessage');
  if (msg) {
    msg.textContent = actionLabel
      ? `Log in to ${actionLabel}. Signing in is free and takes a few seconds.`
      : 'Log in to continue. Signing in is free and takes a few seconds.';
  }
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

// ============================================================
// 1. User profile chrome
// ============================================================
function initUserProfile() {
  const avatar = currentUser.avatar || '';
  const fallback = avatarFor(currentUser.username);

  const sidebarAvatar = document.getElementById('sidebarUserAvatar');
  const sidebarUsername = document.getElementById('sidebarUsername');
  const userStoryAvatar = document.getElementById('userStoryAvatar');
  const rightAvatar = document.getElementById('rightWidgetAvatar');
  const rightUser = document.getElementById('rightWidgetUsername');
  const rightName = document.getElementById('rightWidgetName');
  const rightBadge = document.getElementById('rightWidgetBadge');
  const bottomNavAvatar = document.getElementById('bottomNavUserAvatar');

  if (sidebarAvatar) sidebarAvatar.src = avatar || fallback;
  if (sidebarUsername) sidebarUsername.textContent = currentUser.username || 'Profile';
  if (userStoryAvatar) userStoryAvatar.src = avatar || fallback;
  if (rightAvatar) rightAvatar.src = avatar || fallback;
  if (rightUser) rightUser.textContent = currentUser.username || 'guest_traveler';
  if (rightName) rightName.textContent = currentUser.name || 'Travel Explorer';
  if (bottomNavAvatar) bottomNavAvatar.src = avatar || fallback;

  const isVerifiedPro = !!(currentUser.is_verified_pro || currentUser.role === 'professional');
  if (rightBadge) rightBadge.classList.toggle('hidden', !isVerifiedPro);

  const feedUpgradeProWidget = document.getElementById('feedUpgradeProWidget');
  if (feedUpgradeProWidget) feedUpgradeProWidget.classList.toggle('hidden', isVerifiedPro);

  const guestBanner = document.getElementById('guestLoginBanner');
  if (guestBanner) guestBanner.classList.toggle('hidden', !isGuest);

  // Logout & Switch Account
  const logoutBtn = document.getElementById('menuLogout');
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      sessionStorage.removeItem('currentUser');
      if (window.setAuthToken) window.setAuthToken(null);
      window.location.href = 'auth.html';
    };
  }

  const switchBtn = document.getElementById('menuSwitchAccount');
  if (switchBtn) {
    switchBtn.onclick = () => {
      window.location.href = 'auth.html?mode=login';
    };
  }
}

// ============================================================
// 2. Navigation & views
// ============================================================
function initSidebarNavigation() {
  const navHome = document.getElementById('navHome');
  const navSearch = document.getElementById('navSearch');
  const navExplore = document.getElementById('navExplore') || document.getElementById('mobNavExplore');
  const navReels = document.getElementById('navReels');
  const navMessages = document.getElementById('navMessages');
  const navNotifications = document.getElementById('navNotifications');
  const navCreate = document.getElementById('navCreate');
  const navSaved = document.getElementById('navSaved');
  const navProfile = document.getElementById('navProfile');
  const navMore = document.getElementById('navMore');
  const morePopover = document.getElementById('moreMenuPopover');

  const showHome = () => {
    currentFilter = 'all';
    resetFilterPills();
    searchQuery = '';
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    const feedSearchInput = document.getElementById('feedSearchInput');
    if (feedSearchInput) feedSearchInput.value = '';
    renderLimit = 12;
    setView('home', navHome);
    renderFeed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const showExplore = () => {
    setView('explore', navExplore);
    renderExploreGrid();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const openMessages = () => {
    const sidebar = document.getElementById('chatSidebar');
    if (!sidebar) return;
    sidebar.style.right = '0';
    loadDMThreads();
  };
  const openNotifications = () => {
    const drawer = document.getElementById('notificationsDrawer');
    if (!drawer) return;
    drawer.classList.toggle('open');
    if (drawer.classList.contains('open')) loadNotifications();
  };
  const openProfile = () => {
    if (isGuest) return openAuthPrompt('view your profile');
    showUserProfileModal(currentUser.username);
  };
  const openCreate = () => {
    if (!requireAuth('share a new spot')) return;
    openCreateModal();
  };
  const toggleSearch = () => {
    const drawer = document.getElementById('searchDrawer');
    const input = document.getElementById('searchInput');
    if (!drawer || !input) return;
    drawer.classList.toggle('open');
    if (drawer.classList.contains('open')) {
      input.focus();
      renderSearchResults(input.value.trim());
    }
  };

  // Filter Pills
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.getAttribute('data-filter');
      renderLimit = 12;
      if (currentFilter === 'saved') {
        setView('saved', navSaved);
      } else {
        setView('home', navHome);
      }
      renderFeed();
    });
  });

  if (navHome) navHome.addEventListener('click', showHome);

  if (navExplore) navExplore.addEventListener('click', showExplore);

  if (navReels) {
    navReels.addEventListener('click', () => {
      setView('reels', navReels);
      renderReels();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  if (navSaved) {
    navSaved.addEventListener('click', () => {
      currentFilter = 'saved';
      highlightFilterPill('saved');
      renderLimit = 12;
      setView('saved', navSaved);
      renderFeed();
    });
  }

  if (navCreate) navCreate.addEventListener('click', openCreate);

  const feedCreateAction = document.getElementById('feedCreateAction');
  if (feedCreateAction) feedCreateAction.addEventListener('click', () => navCreate.click());

  // Profile Click opens the full profile modal
  if (navProfile) navProfile.addEventListener('click', openProfile);

  // Bottom navigation has its own actions; do not proxy clicks through a
  // desktop control, since on compact layouts the bottom control is the only one.
  const bindBottomAction = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      document.querySelectorAll('.mobile-bottom-nav .bottom-nav-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      fn();
    });
  };
  bindBottomAction('mobNavHome', showHome);
  bindBottomAction('mobNavSearch', toggleSearch);
  bindBottomAction('mobNavCreate', openCreate);
  bindBottomAction('mobNavProfile', openProfile);
  bindBottomAction('mobNavNotifications', openNotifications);
  bindBottomAction('mobNavMessages', openMessages);

  // More Menu Popover
  if (navMore && morePopover) navMore.addEventListener('click', (e) => {
    e.stopPropagation();
    morePopover.classList.toggle('active');
  });

  document.addEventListener('click', (e) => {
    if (navMore && morePopover && !navMore.contains(e.target) && !morePopover.contains(e.target)) {
      morePopover.classList.remove('active');
    }
  });
}

function setView(view, activeBtn) {
  currentView = view;
  const feedContainer = document.getElementById('feedContainer');
  const exploreView = document.getElementById('exploreView');
  const reelsView = document.getElementById('reelsView');

  if (feedContainer) feedContainer.classList.toggle('hidden', view !== 'home' && view !== 'saved');
  if (exploreView) exploreView.classList.toggle('hidden', view !== 'explore');
  if (reelsView) reelsView.classList.toggle('hidden', view !== 'reels');

  document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
}

function resetFilterPills() {
  document.querySelectorAll('.filter-pill').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-filter') === 'all');
  });
}

function highlightFilterPill(filterName) {
  document.querySelectorAll('.filter-pill').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-filter') === filterName);
  });
}

// ============================================================
// 3. Stories
// ============================================================
async function initStories() {
  const createStoryBubble = document.getElementById('createStoryBubble');

  if (createStoryBubble) {
    createStoryBubble.addEventListener('click', () => {
      if (!requireAuth('post a story')) return;
      const modal = document.getElementById('storyCreateModal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    });
  }

  try {
    stories = await api(`/stories?user_id=${currentUser.id}`) || [];
  } catch (err) {
    console.warn('Could not load stories:', err);
    stories = [];
  }

  renderStoriesTray();

  // Story viewer controls
  const closeBtn = document.getElementById('closeStoryViewerBtn');
  const tapPrev = document.getElementById('storyTapPrev');
  const tapNext = document.getElementById('storyTapNext');
  const replyInput = document.getElementById('storyReplyInput');
  const storyCard = document.querySelector('.story-screen-card');

  closeBtn.onclick = closeStoryViewer;
  tapPrev.onclick = () => navigateStory(-1);
  tapNext.onclick = () => navigateStory(1);

  if (storyCard) {
    storyCard.addEventListener('mousedown', () => { storyIsPaused = true; });
    storyCard.addEventListener('mouseup', () => { storyIsPaused = false; });
    storyCard.addEventListener('mouseleave', () => { storyIsPaused = false; });
    storyCard.addEventListener('touchstart', () => { storyIsPaused = true; }, { passive: true });
    storyCard.addEventListener('touchend', () => { storyIsPaused = false; });
  }

  if (replyInput) {
    replyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && replyInput.value.trim()) {
        e.preventDefault();
        const text = replyInput.value.trim();
        replyInput.value = '';
        sendStoryReply(text);
      }
    });
  }

  // Story creator file upload
  const storyFileInput = document.getElementById('newStoryMediaFile');
  const storyPreview = document.getElementById('storyMediaPreview');
  const storyPlaceholder = document.getElementById('storyUploadPlaceholder');
  if (storyFileInput) {
    storyFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        storyPreview.src = evt.target.result;
        storyPreview.classList.remove('hidden');
        if (storyPlaceholder) storyPlaceholder.classList.add('hidden');
        document.getElementById('newStoryMedia').value = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
}

function renderStoriesTray() {
  const storiesWrap = document.getElementById('storiesListWrap');
  if (!storiesWrap) return;
  storiesWrap.innerHTML = '';

  if (stories.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'text-[11px] text-white/45 px-2';
    empty.textContent = 'No stories yet — be the first to share a spot.';
    storiesWrap.appendChild(empty);
    return;
  }

  stories.forEach((story, idx) => {
    const bubble = document.createElement('div');
    bubble.className = 'story-bubble';
    bubble.innerHTML = `
      <div class="story-ring-wrap ${story.isSeen ? 'seen' : ''}" id="story-ring-${story.id}">
        <img src="${escapeHtml(story.avatar || avatarFor(story.username))}" class="story-avatar-img" alt="${escapeHtml(story.username)}">
      </div>
      <span class="story-author-name">${escapeHtml(story.username)}</span>
    `;
    bubble.addEventListener('click', () => openStoryViewer(idx));
    storiesWrap.appendChild(bubble);
  });
}

function openStoryViewer(index) {
  activeStoryIndex = index;
  const modal = document.getElementById('storyViewerModal');
  modal.classList.add('active');
  renderCurrentStory();

  const story = stories[activeStoryIndex];
  if (story) {
    api(`/stories/${story.id}/view`, {
      method: 'POST',
      body: JSON.stringify({ user_id: currentUser.id })
    }).catch(() => {});
    story.isSeen = true;
    const ring = document.getElementById(`story-ring-${story.id}`);
    if (ring) ring.classList.add('seen');
  }
}

function renderCurrentStory() {
  if (!stories || stories.length === 0) return;
  const story = stories[activeStoryIndex];

  const avatar = document.getElementById('storyViewerAvatar');
  const username = document.getElementById('storyViewerUsername');
  const proBadge = document.getElementById('storyViewerProBadge');
  const spot = document.getElementById('storyViewerSpot');
  const time = document.getElementById('storyViewerTime');
  const media = document.getElementById('storyViewerMedia');
  const caption = document.getElementById('storyViewerCaption');

  avatar.src = story.avatar || avatarFor(story.username);
  username.textContent = story.username;
  proBadge.style.display = story.is_verified_pro ? 'inline' : 'none';
  spot.textContent = `${String.fromCodePoint(0x2316)} ${story.spot || 'Field note'}`;
  time.textContent = storyTimeLabel(story);
  media.src = story.media;
  caption.textContent = story.caption || '';

  renderSegmentedProgressBars();

  if (storyTimer) clearInterval(storyTimer);
  let progress = 0;
  const activeFill = document.getElementById(`story-fill-${activeStoryIndex}`);

  storyTimer = setInterval(() => {
    if (storyIsPaused) return;
    progress += 2;
    if (activeFill) activeFill.style.width = `${progress}%`;
    if (progress >= 100) {
      clearInterval(storyTimer);
      if (activeStoryIndex < stories.length - 1) {
        navigateStory(1);
      } else {
        closeStoryViewer();
      }
    }
  }, 100);
}

function storyTimeLabel(story) {
  const created = new Date(story.created_at || Date.now()).getTime();
  const mins = Math.floor((Date.now() - created) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderSegmentedProgressBars() {
  const container = document.getElementById('storyProgressSegments');
  if (!container) return;
  container.innerHTML = '';
  stories.forEach((_, i) => {
    const seg = document.createElement('div');
    seg.className = 'story-progress-segment';
    const fill = document.createElement('div');
    fill.className = 'story-progress-fill';
    fill.id = `story-fill-${i}`;
    if (i < activeStoryIndex) fill.style.width = '100%';
    else if (i > activeStoryIndex) fill.style.width = '0%';
    seg.appendChild(fill);
    container.appendChild(seg);
  });
}

function navigateStory(direction) {
  const nextIdx = activeStoryIndex + direction;
  if (nextIdx >= 0 && nextIdx < stories.length) {
    activeStoryIndex = nextIdx;
    renderCurrentStory();
    const story = stories[activeStoryIndex];
    if (story) {
      api(`/stories/${story.id}/view`, {
        method: 'POST',
        body: JSON.stringify({ user_id: currentUser.id })
      }).catch(() => {});
    }
  } else {
    closeStoryViewer();
  }
}

function closeStoryViewer() {
  const modal = document.getElementById('storyViewerModal');
  if (modal) modal.classList.remove('active');
  if (storyTimer) clearInterval(storyTimer);
}

function createFloatingSymbol(symbol) {
  const modal = document.getElementById('storyViewerModal');
  if (!modal) return;
  const el = document.createElement('span');
  el.className = 'floating-reaction-mark';
  el.textContent = symbol;
  el.style.left = `${40 + Math.random() * 20}%`;
  modal.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// A story reply is delivered as a direct message to the creator.
async function sendStoryReply(text) {
  const story = stories[activeStoryIndex];
  if (!story) return;
  if (!requireAuth('reply to a story')) return;

  try {
    await api('/messages', {
      method: 'POST',
      body: JSON.stringify({
        from_user_id: currentUser.id,
        from_username: currentUser.username,
        to_username: story.username,
        text
      })
    });
    showToast(`Reply sent to @${story.username}`);
    loadDMThreads();
  } catch (err) {
    showToast('Could not send the reply. Please try again.');
  }
}

// Story reaction symbol -> delivered as a message to the creator.
window.sendStoryReaction = async function (symbol) {
  const story = stories[activeStoryIndex];
  if (!story) return;
  if (!requireAuth('react to a story')) return;
  createFloatingSymbol(symbol);

  try {
    await api('/messages', {
      method: 'POST',
      body: JSON.stringify({
        from_user_id: currentUser.id,
        from_username: currentUser.username,
        to_username: story.username,
        text: symbol
      })
    });
    showToast(`Sent ${symbol} to @${story.username}`);
    loadDMThreads();
  } catch (err) {
    showToast('Could not send the reaction.');
  }
};

// ============================================================
// 4. Load & render the feed
// ============================================================
async function loadPosts() {
  const feedContainer = document.getElementById('feedContainer');
  if (feedContainer) feedContainer.innerHTML = '<div class="glass-panel p-8 rounded-2xl text-center text-white/70 text-xs font-medium">Loading spots...</div>';

  try {
    allPosts = await api(`/posts?user_id=${currentUser.id}`) || [];
  } catch (err) {
    allPosts = [];
    console.error('Could not load spots from MongoDB:', err);
  }

  renderFeed();
}

function getHiddenPostIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_POSTS_KEY) || '[]').map(String));
  } catch (e) {
    return new Set();
  }
}

function trendingScore(post) {
  const likes = post.likes || 0;
  const comments = (post.comments || []).length;
  const ageHours = Math.max(1, (Date.now() - new Date(post.created_at || Date.now()).getTime()) / 36e5);
  const recency = 72 / ageHours;
  return likes + comments * 3 + recency;
}

function getFilteredPosts(query = '') {
  const hidden = getHiddenPostIds();

  let filtered = allPosts.filter(p => {
    if (hidden.has(String(p.id))) return false;
    if (currentFilter === 'verified' && !p.is_verified_pro && p.user_role !== 'professional') return false;
    if (currentFilter === 'saved' && !p.isSaved) return false;

    if (query) {
      const q = query.toLowerCase();
      const haystack = [
        p.location, p.username, p.description, p.hotel_name,
        p.food_place, p.must_visit_name, p.transport_type
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (currentFilter === 'trending') {
    filtered = filtered.slice().sort((a, b) => trendingScore(b) - trendingScore(a));
    filtered = filtered.slice(0, Math.max(5, Math.ceil(filtered.length * 0.4)));
  } else {
    filtered = filtered.slice().sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
  }

  return filtered;
}

function renderFeed(query = '') {
  const feedContainer = document.getElementById('feedContainer');
  if (!feedContainer) return;
  feedContainer.innerHTML = '';

  const filtered = getFilteredPosts(query);
  lastFilteredCount = filtered.length;

  if (filtered.length === 0) {
    feedContainer.innerHTML = buildEmptyState();
    bindEmptyStateActions();
    return;
  }

  const postBatch = document.createDocumentFragment();
  filtered.slice(0, renderLimit).forEach(post => {
    postBatch.appendChild(createPostElement(post));
  });
  feedContainer.appendChild(postBatch);
}

function buildEmptyState() {
  if (currentFilter === 'saved') {
    return `
      <div class="glass-panel rounded-2xl feed-empty-state">
        <span class="text-4xl">◇</span>
        <h3 class="font-bold text-sm text-white">No saved spots yet</h3>
        <p class="text-xs text-white/70 max-w-sm leading-relaxed">
          Tap the bookmark icon on any spot to keep it here for later.
        </p>
      </div>`;
  }
  if (currentFilter === 'verified') {
    return `
      <div class="glass-panel rounded-2xl feed-empty-state">
        <span class="text-4xl">✓</span>
        <h3 class="font-bold text-sm text-white">No verified spots yet</h3>
        <p class="text-xs text-white/70 max-w-sm leading-relaxed">
          Verified Pro Creators have not published a spot yet. Check back soon.
        </p>
      </div>`;
  }
  if (searchQuery) {
    return `
      <div class="glass-panel rounded-2xl feed-empty-state">
        <span class="text-4xl">⌕</span>
        <h3 class="font-bold text-sm text-white">No spots match "${escapeHtml(searchQuery)}"</h3>
        <p class="text-xs text-white/70 max-w-sm leading-relaxed">
          Try a different place, a creator name or a hashtag.
        </p>
      </div>`;
  }
  return `
    <div class="glass-panel rounded-2xl feed-empty-state">
      <span class="text-4xl">＋</span>
      <h3 class="font-bold text-sm text-white">No spots yet</h3>
      <p class="text-xs text-white/70 max-w-sm leading-relaxed">
        Share the first secret spot with the community.
      </p>
      <button class="mt-2 px-4 py-2 rounded-xl text-xs font-bold bg-[#d2a35c] text-[#070c0a] hover:bg-[#e6c78e] transition-colors" id="emptyCreateBtn">Create a spot</button>
    </div>`;
}

function bindEmptyStateActions() {
  const btn = document.getElementById('emptyCreateBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!requireAuth('share a new spot')) return;
      openCreateModal();
    });
  }
}

// ---- Post card ----------------------------------------------------------
function createPostElement(post) {
  const article = document.createElement('article');
  article.className = 'field-note-card';
  article.id = `post-${post.id}`;

  const isPro = post.is_verified_pro || post.user_role === 'professional';
  const authorAvatar = post.author_avatar || avatarFor(post.username);
  const mediaList = getMediaList(post);
  const comments = post.comments || [];
  const previewComments = comments.slice(0, 2);
  const remainingComments = comments.slice(2);
  const isOwner = post.isOwner || post.username === currentUser.username;
  const relativeTime = getRelativeTime(post.created_at);

  const commentsHtml = previewComments.map(c => `
    <div class="comment-row">
      <strong class="cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(c.username)}')">${escapeHtml(c.username)}</strong>
      <span>${escapeHtml(c.text)}</span>
    </div>
  `).join('');

  const remainingHtml = remainingComments.map(c => `
    <div class="comment-row">
      <strong class="cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(c.username)}')">${escapeHtml(c.username)}</strong>
      <span>${escapeHtml(c.text)}</span>
    </div>
  `).join('');

  article.innerHTML = `
    <header class="post-header">
      <div class="post-author-wrap">
        <div class="post-author-avatar cursor-pointer" onclick="window.openUserProfile('${escapeHtml(post.username)}')">
          <img src="${escapeHtml(authorAvatar)}" alt="${escapeHtml(post.username)}">
        </div>
        <div class="post-meta-info">
          <div class="author-title-row">
            <span class="post-username cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(post.username)}')">${escapeHtml(post.username)}</span>
            ${isPro ? `<span class="post-verified-badge" title="Creator verification status">✓ Pro</span>` : ''}
            <span class="text-[10px] text-white/40 flex-shrink-0">• ${relativeTime}</span>
          </div>
          ${post.location ? `<span class="post-location-tag" data-loc="${encodeURIComponent(post.location)}">&#x2316; ${escapeHtml(cleanLocationDisplay(post.location))}</span>` : ''}
        </div>
      </div>

      <div class="post-header-actions">
        ${post.username !== currentUser.username ? `
          <button class="follow-pill-btn ${post.isFollowing ? 'following' : ''}" data-userid="${post.user_id}" data-username="${encodeURIComponent(post.username)}">
            ${post.isFollowing ? 'Following' : 'Follow'}
          </button>
        ` : ''}
        <button class="post-menu-btn" data-postid="${post.id}" title="More options">•••</button>
      </div>
    </header>

    <div class="post-media-container" id="media-box-${post.id}">
      <div class="post-media-stage" id="media-stage-${post.id}" data-filter="${escapeHtml(post.filter_css || 'none')}">${mediaMarkup(mediaList[0], post.filter_css || 'none')}</div>
      <div class="double-tap-heart" id="heart-burst-${post.id}">♥</div>

      <div class="post-ai-badge-pill" data-postid="${post.id}" title="Click to view AI trust audit">
        ${post.is_ai_altered
          ? `<span class="text-red-400">⚑ AI Altered</span>`
          : (post.ai_trust_score != null
              ? `<span class="text-emerald-300">⛨ Integrity Scanned (${post.ai_trust_score}%)</span>`
              : `<span class="text-white/60">⛨ Not Scanned</span>`)}
      </div>

      ${mediaList.length > 1 ? `
        <button class="carousel-btn carousel-prev" data-postid="${post.id}" data-dir="-1" title="Previous">‹</button>
        <button class="carousel-btn carousel-next" data-postid="${post.id}" data-dir="1" title="Next">›</button>
        <div class="carousel-dots-wrap" id="dots-${post.id}">
          ${mediaList.map((_, i) => `<span class="carousel-dot ${i === 0 ? 'active' : ''}"></span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="post-action-bar">
      <div class="action-buttons-left">
        <button class="action-icon-btn ${post.isLiked ? 'liked' : ''}" id="like-btn-${post.id}" data-postid="${post.id}" title="Like">
          ${post.isLiked ? '♥' : '♡'}
        </button>
        <button class="action-icon-btn" data-postid="${post.id}" id="comment-bubble-${post.id}" title="View & add comments">
          &#x25E6;
        </button>
        <button class="action-icon-btn" data-postid="${post.id}" id="share-btn-${post.id}" title="Share spot">
          &#x2197;
        </button>
      </div>

      <button class="action-icon-btn ${post.isSaved ? 'saved' : ''}" id="save-btn-${post.id}" data-postid="${post.id}" title="Bookmark spot">
        ${post.isSaved ? '◇' : '◇'}
      </button>
    </div>

    <div class="post-likes-count">
      <span id="like-count-${post.id}">${post.likes || 0}</span> likes
    </div>

    <div class="post-caption-section">
      <span class="caption-username cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(post.username)}')">${escapeHtml(post.username)}</span>
      <span id="caption-text-${post.id}">${formatCaption(escapeHtml(post.description || ''))}</span>
    </div>

    ${hasSpotGuide(post) ? `
      <div class="spot-guide-wrap">
        <button class="spot-guide-toggle" data-postid="${post.id}">
          <span>⌖ Spot Intelligence Guide (Stay, Ride, Food)</span>
          <span id="guide-arrow-${post.id}">▾</span>
        </button>
        <div class="spot-guide-body hidden" id="guide-body-${post.id}">
          ${post.hotel_name || post.hotel_feedback ? `
            <div class="spot-info-item">
              <span>⌂</span>
              <div>
                <strong>Hotel / Stay:</strong> ${escapeHtml(post.hotel_name || 'Recommended Stay')}
                ${post.hotel_feedback ? `<div class="text-[11px] text-white/75 mt-0.5">${escapeHtml(post.hotel_feedback)}</div>` : ''}
                ${post.hotel_contact ? `<div class="text-[10px] text-[#d2a35c] font-mono mt-0.5">Booking / Contact: ${escapeHtml(post.hotel_contact)}</div>` : ''}
              </div>
            </div>` : ''}

          ${post.transport_type || post.transport_price ? `
            <div class="spot-info-item">
              <span>⇄</span>
              <div>
                <strong>Transport:</strong> ${escapeHtml(post.transport_type || 'Transit')} • Price: ${escapeHtml(post.transport_price || 'N/A')}
                ${post.transport_contact ? `<div class="text-[10px] text-[#d2a35c] mt-0.5">Where: ${escapeHtml(post.transport_contact)}</div>` : ''}
              </div>
            </div>` : ''}

          ${post.route_desc ? `
            <div class="spot-info-item">
              <span>⌖</span>
              <div>
                <strong>Route Tips:</strong>
                ${post.route_desc.startsWith('http')
                  ? `<a href="${escapeHtml(post.route_desc)}" target="_blank" rel="noopener noreferrer" class="text-[#d2a35c] underline hover:text-[#e6c78e] font-semibold block mt-0.5">&#x2316; Open map route</a>`
                  : `<span>${escapeHtml(post.route_desc)}</span>`}
                ${post.route_cost ? `<span class="text-[#d2a35c] font-bold ml-1.5">(Total: ${escapeHtml(post.route_cost)})</span>` : ''}
              </div>
            </div>` : ''}

          ${post.food_place || post.food_feedback ? `
            <div class="spot-info-item">
              <span>⋈</span>
              <div>
                <strong>Food & Dining:</strong> ${escapeHtml(post.food_place || 'Eatery')} ${post.food_price ? `(${escapeHtml(post.food_price)})` : ''}
                ${post.food_feedback ? `<div class="text-[11px] text-white/75 italic mt-0.5">"${escapeHtml(post.food_feedback)}"</div>` : ''}
              </div>
            </div>` : ''}

          ${post.must_visit_name ? `
            <div class="spot-info-item">
              <span>⌖</span>
              <div>
                <strong>Must Visit Nearby:</strong> ${escapeHtml(post.must_visit_name)}
              </div>
            </div>` : ''}
        </div>
      </div>
    ` : ''}

    <div class="post-comments-section" id="comments-box-${post.id}">
      ${comments.length > 2 ? `
        <span class="view-all-comments-btn cursor-pointer" data-postid="${post.id}">
          View all ${comments.length} comments
        </span>` : ''}
      <div id="comment-list-${post.id}">${commentsHtml}</div>
      <div id="comment-hidden-list-${post.id}" class="hidden">${remainingHtml}</div>
    </div>

    <form class="post-add-comment-box" data-postid="${post.id}">
      <div class="quick-symbols-row">
        <button type="button" class="quick-symbol-btn" data-postid="${post.id}" data-symbol="♥">♥</button>
        <button type="button" class="quick-symbol-btn" data-postid="${post.id}" data-symbol="✦">✦</button>
        <button type="button" class="quick-symbol-btn" data-postid="${post.id}" data-symbol="⌖">⌖</button>
      </div>
      <input type="text" id="comment-input-${post.id}" placeholder="Add a comment for ${escapeHtml(post.username)}..." class="comment-input-field">
      <button type="submit" id="comment-submit-${post.id}" class="comment-post-btn">Post</button>
    </form>
  `;

  article.dataset.carouselMedia = JSON.stringify(mediaList);
  article.dataset.carouselIndex = '0';
  article.dataset.isOwner = isOwner ? '1' : '0';

  attachPostCardListeners(article, post);
  return article;
}

function getMediaList(post) {
  if (Array.isArray(post.carousel_media) && post.carousel_media.length > 0) return post.carousel_media;
  if (post.media) return [post.media];
  return [];
}

function isVideoSource(src) {
  if (!src) return false;
  if (src.startsWith('data:video')) return true;
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src);
}

// Builds the markup for one media slide (photo or clip).
function mediaMarkup(src, filterCss) {
  const style = filterCss && filterCss !== 'none' ? `style="filter: ${filterCss};"` : '';

  if (!src) {
    return '<div class="post-media-empty flex items-center justify-center text-xs text-white/50 h-full w-full">◉ No photo attached to this spot</div>';
  }
  if (isVideoSource(src)) {
    return `<video src="${escapeHtml(src)}" class="post-media-video" controls playsinline preload="metadata" ${style}></video>`;
  }
  return `<img src="${escapeHtml(src)}" class="post-media-img" alt="Spot photo" ${style}>`;
}

function renderMediaStage(postId, index) {
  const stage = document.getElementById(`media-stage-${postId}`);
  if (!stage) return;
  const article = document.getElementById(`post-${postId}`);
  if (!article) return;

  const list = JSON.parse(article.dataset.carouselMedia || '[]');
  const filterCss = stage.getAttribute('data-filter') || 'none';
  stage.innerHTML = mediaMarkup(list[index], filterCss);
}

function hasSpotGuide(p) {
  return p.hotel_name || p.hotel_feedback || p.transport_type || p.route_desc || p.food_place || p.must_visit_name;
}

function attachPostCardListeners(card, post) {
  const postId = post.id;

  const mediaBox = card.querySelector(`#media-box-${postId}`);
  mediaBox.addEventListener('dblclick', () => handleDoubleTapLike(postId));

  let lastTouchTime = 0;
  mediaBox.addEventListener('touchend', (e) => {
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTouchTime;
    if (tapLength < 320 && tapLength > 0) {
      handleDoubleTapLike(postId);
      e.preventDefault();
    }
    lastTouchTime = currentTime;
  });

  card.querySelectorAll('.carousel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      changeCarouselSlide(postId, parseInt(btn.getAttribute('data-dir')));
    });
  });

  const trustPill = card.querySelector('.post-ai-badge-pill');
  if (trustPill) {
    trustPill.addEventListener('click', (e) => {
      e.stopPropagation();
      openAiTrustDetails(postId);
    });
  }

  const locTag = card.querySelector('.post-location-tag');
  if (locTag) {
    locTag.addEventListener('click', () => {
      window.searchLocation(decodeURIComponent(locTag.getAttribute('data-loc')));
    });
  }

  const followBtn = card.querySelector('.follow-pill-btn');
  if (followBtn) {
    followBtn.addEventListener('click', () => {
      handleFollowToggle(followBtn.getAttribute('data-userid'),
        decodeURIComponent(followBtn.getAttribute('data-username')), followBtn);
    });
  }

  const menuBtn = card.querySelector('.post-menu-btn');
  if (menuBtn) menuBtn.addEventListener('click', () => openPostMenu(postId));

  const likeBtn = card.querySelector(`#like-btn-${postId}`);
  if (likeBtn) likeBtn.addEventListener('click', () => handleLikeToggle(postId, likeBtn));

  const commentBubble = card.querySelector(`#comment-bubble-${postId}`);
  if (commentBubble) commentBubble.addEventListener('click', () => openFullCommentsModal(postId));

  const shareBtn = card.querySelector(`#share-btn-${postId}`);
  if (shareBtn) shareBtn.addEventListener('click', () => openShareModal(postId));

  const saveBtn = card.querySelector(`#save-btn-${postId}`);
  if (saveBtn) saveBtn.addEventListener('click', () => handleSaveToggle(postId, saveBtn));

  const guideToggle = card.querySelector('.spot-guide-toggle');
  if (guideToggle) guideToggle.addEventListener('click', () => toggleSpotGuide(postId));

  const viewAllBtn = card.querySelector('.view-all-comments-btn');
  if (viewAllBtn) viewAllBtn.addEventListener('click', () => openFullCommentsModal(postId));

  card.querySelectorAll('.quick-symbol-btn').forEach(symbolBtn => {
    symbolBtn.addEventListener('click', () => {
      const input = card.querySelector(`#comment-input-${postId}`);
      if (input) {
        input.value += symbolBtn.getAttribute('data-symbol');
        input.focus();
        togglePostCommentBtn(postId, input);
      }
    });
  });

  const commentInput = card.querySelector(`#comment-input-${postId}`);
  if (commentInput) commentInput.addEventListener('input', () => togglePostCommentBtn(postId, commentInput));

  const commentForm = card.querySelector('.post-add-comment-box');
  if (commentForm) {
    commentForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleCommentSubmit(postId, commentInput);
    });
  }
}

// ============================================================
// 5. Post actions
// ============================================================
function handleDoubleTapLike(postId) {
  const heart = document.getElementById(`heart-burst-${postId}`);
  if (heart) {
    heart.classList.remove('animate');
    void heart.offsetWidth;
    heart.classList.add('animate');
  }
  const likeBtn = document.getElementById(`like-btn-${postId}`);
  if (likeBtn && !likeBtn.classList.contains('liked')) {
    handleLikeToggle(postId, likeBtn);
  }
}

async function handleLikeToggle(postId, btnEl) {
  if (!requireAuth('like spots')) return;

  const countEl = document.getElementById(`like-count-${postId}`);
  const wasLiked = btnEl.classList.contains('liked');
  const count = parseInt(countEl ? countEl.innerText : '0') || 0;

  btnEl.classList.toggle('liked', !wasLiked);
  btnEl.textContent = wasLiked ? '♥' : '♡';
  if (countEl) countEl.innerText = Math.max(0, count + (wasLiked ? -1 : 1));

  const post = allPosts.find(item => String(item.id) === String(postId));
  if (post) {
    post.isLiked = !wasLiked;
    post.likes = Math.max(0, count + (wasLiked ? -1 : 1));
  }

  try {
    const res = await api(`/posts/${postId}/like`, {
      method: 'POST',
      body: JSON.stringify({ user_id: currentUser.id })
    });
    if (res && typeof res.likes === 'number' && countEl) countEl.innerText = res.likes;
    if (post && res && typeof res.likes === 'number') post.likes = res.likes;
    loadNotifications();
  } catch (err) {
    // Roll the optimistic update back if the platform rejected it.
    btnEl.classList.toggle('liked', wasLiked);
    btnEl.textContent = wasLiked ? '♥' : '♡';
    if (countEl) countEl.innerText = count;
    if (post) { post.isLiked = wasLiked; post.likes = count; }
    showToast('Could not save that like. Please try again.');
  }
}

async function handleSaveToggle(postId, btnEl) {
  if (!requireAuth('save spots')) return;

  const wasSaved = btnEl.classList.contains('saved');
  btnEl.classList.toggle('saved', !wasSaved);
  btnEl.textContent = wasSaved ? '◆' : '◇';

  const post = allPosts.find(item => String(item.id) === String(postId));
  if (post) post.isSaved = !wasSaved;

  try {
    await api(`/posts/${postId}/save`, {
      method: 'POST',
      body: JSON.stringify({ user_id: currentUser.id })
    });
    showToast(wasSaved ? 'Removed from saved spots' : 'Saved to your collection');
    if (currentFilter === 'saved' && wasSaved) renderFeed(searchQuery);
  } catch (err) {
    btnEl.classList.toggle('saved', wasSaved);
    btnEl.textContent = wasSaved ? '◆' : '◇';
    if (post) post.isSaved = wasSaved;
    showToast('Could not update your saved spots.');
  }
}

async function handleFollowToggle(userId, username, btnEl) {
  if (!requireAuth('follow travelers')) return;

  const wasFollowing = btnEl.classList.contains('following');
  btnEl.classList.toggle('following', !wasFollowing);
  btnEl.textContent = wasFollowing ? 'Follow' : 'Following';

  allPosts.forEach(p => {
    if (p.username === username) p.isFollowing = !wasFollowing;
  });

  try {
    await api('/users/follow', {
      method: 'POST',
      body: JSON.stringify({ follower_id: currentUser.id, following_username: username })
    });
    showToast(wasFollowing ? `Unfollowed @${username}` : `Now following @${username}`);
    loadSuggestions();
    loadNotifications();
  } catch (err) {
    btnEl.classList.toggle('following', wasFollowing);
    btnEl.textContent = wasFollowing ? 'Following' : 'Follow';
    allPosts.forEach(p => {
      if (p.username === username) p.isFollowing = wasFollowing;
    });
    showToast('Could not update the follow. Please try again.');
  }
}

function toggleSpotGuide(postId) {
  const body = document.getElementById(`guide-body-${postId}`);
  const arrow = document.getElementById(`guide-arrow-${postId}`);
  if (body) {
    body.classList.toggle('hidden');
    arrow.textContent = body.classList.contains('hidden') ? '▾' : '▴';
  }
}

function togglePostCommentBtn(postId, input) {
  const btn = document.getElementById(`comment-submit-${postId}`);
  if (btn) btn.classList.toggle('active', input.value.trim().length > 0);
}

async function handleCommentSubmit(postId, input) {
  const text = input.value.trim();
  if (!text) return;
  if (!requireAuth('comment on spots')) return;

  try {
    const saved = await api(`/posts/${postId}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        username: currentUser.username,
        user_id: currentUser.id,
        avatar: currentUser.avatar,
        text
      })
    });

    const post = allPosts.find(item => String(item.id) === String(postId));
    if (post) {
      if (!post.comments) post.comments = [];
      post.comments.push(saved);
    }

    const list = document.getElementById(`comment-list-${postId}`);
    if (list) {
      list.insertAdjacentHTML('beforeend', `
        <div class="comment-row">
          <strong class="cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(saved.username)}')">${escapeHtml(saved.username)}</strong>
          <span>${escapeHtml(saved.text)}</span>
        </div>
      `);
    }

    const viewAllBtn = document.querySelector(`#post-${postId} .view-all-comments-btn`);
    if (viewAllBtn && post) viewAllBtn.textContent = `View all ${post.comments.length} comments`;

    input.value = '';
    togglePostCommentBtn(postId, input);
    showToast('Comment posted');
    loadNotifications();
  } catch (err) {
    showToast('Could not post the comment. Please try again.');
  }
}

function changeCarouselSlide(postId, direction) {
  const article = document.getElementById(`post-${postId}`);
  if (!article) return;
  const list = JSON.parse(article.dataset.carouselMedia || '[]');
  if (list.length === 0) return;

  let idx = parseInt(article.dataset.carouselIndex || '0');
  idx = (idx + direction + list.length) % list.length;
  article.dataset.carouselIndex = idx.toString();

  renderMediaStage(postId, idx);

  const dots = document.querySelectorAll(`#dots-${postId} .carousel-dot`);
  dots.forEach((d, i) => d.classList.toggle('active', i === idx));
}

// --- Post action sheet ---------------------------------------------------
function openPostMenu(postId) {
  activePostMenuId = postId;
  const post = allPosts.find(p => String(p.id) === String(postId));
  const deleteBtn = document.getElementById('sheetDeleteBtn');
  const isOwner = post && (post.isOwner || post.username === currentUser.username);
  if (deleteBtn) deleteBtn.classList.toggle('hidden', !isOwner);

  const sheet = document.getElementById('postActionSheet');
  sheet.classList.remove('hidden');
}

async function handleDeletePost(postId) {
  const post = allPosts.find(p => String(p.id) === String(postId));
  if (!post) return;
  if (!requireAuth('delete your spots')) return;

  const confirmed = confirm('Delete this spot? This removes the photo, caption, comments and likes.');
  if (!confirmed) return;

  try {
    await api(`/posts/${postId}`, {
      method: 'DELETE',
      body: JSON.stringify({ user_id: currentUser.id, username: currentUser.username })
    });
    allPosts = allPosts.filter(p => String(p.id) !== String(postId));
    renderFeed(searchQuery);
    showToast('Spot deleted');
  } catch (err) {
    showToast(err.message || 'Could not delete the spot.');
  }
}

async function handleReportPost(postId) {
  if (!requireAuth('report spots')) return;
  try {
    await api(`/posts/${postId}/report`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: currentUser.id,
        username: currentUser.username,
        reason: 'Suspicious review or inaccurate spot details'
      })
    });
    showToast('Report submitted for review.');
  } catch (err) {
    showToast('Could not submit the report. Please try again.');
  }
}

function handleHidePost(postId) {
  const hidden = getHiddenPostIds();
  hidden.add(String(postId));
  localStorage.setItem(HIDDEN_POSTS_KEY, JSON.stringify([...hidden]));
  allPosts = allPosts.filter(p => String(p.id) !== String(postId));
  renderFeed(searchQuery);
  showToast('You will see fewer spots like this.');
}

// ============================================================
// 6. Explore grid
// ============================================================
function renderExploreGrid() {
  const grid = document.getElementById('exploreGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (allPosts.length === 0) {
    grid.innerHTML = '<div class="col-span-3 text-center py-10 text-white/50 text-xs">No spots to explore yet.</div>';
    return;
  }

  allPosts.forEach(post => {
    const tile = document.createElement('div');
    tile.className = 'explore-grid-tile cursor-pointer';
    const media = getMediaList(post)[0];
    tile.innerHTML = `
      ${media
        ? `<img src="${escapeHtml(media)}" alt="Explore spot">`
        : `<div class="w-full h-full flex items-center justify-center text-xs text-white/40">No photo</div>`}
      <div class="explore-overlay-stats">
        <span>♥ ${post.likes || 0}</span>
        <span>◦ ${(post.comments || []).length}</span>
      </div>
    `;
    tile.addEventListener('click', () => jumpToPost(post.id));
    grid.appendChild(tile);
  });
}

function jumpToPost(postId) {
  document.getElementById('navHome').click();
  setTimeout(() => {
    const el = document.getElementById(`post-${postId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-pulse');
      setTimeout(() => el.classList.remove('highlight-pulse'), 1800);
    }
  }, 200);
}

// ============================================================
// 7. Motion notes
// ============================================================
function renderReels() {
  const container = document.getElementById('reelsContainer');
  const label = document.getElementById('reelsCountLabel');
  if (!container) return;
  container.innerHTML = '';

  const reels = allPosts.filter(p => getMediaList(p).length > 0);

  if (label) label.textContent = `${reels.length} note${reels.length === 1 ? '' : 's'}`;

  if (reels.length === 0) {
    container.innerHTML = `
      <div class="glass-panel rounded-2xl feed-empty-state">
        <span class="text-4xl">▣</span>
        <h3 class="font-bold text-sm text-white">No motion notes yet</h3>
        <p class="text-xs text-white/70 max-w-sm leading-relaxed">
          Photo and video notes from recent trips appear here.
        </p>
      </div>`;
    return;
  }

  reels.forEach(post => {
    const media = getMediaList(post)[0];
    const video = isVideoSource(media);
    const card = document.createElement('article');
    card.className = 'reel-card';
    card.innerHTML = `
      ${video
        ? `<video src="${escapeHtml(media)}" class="reel-media" muted loop playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(media)}" class="reel-media" alt="Reel from ${escapeHtml(post.username)}">`}
      <div class="reel-shade"></div>

      <div class="reel-info">
        <div class="reel-author">
          <img src="${escapeHtml(post.author_avatar || avatarFor(post.username))}" class="reel-author-avatar" alt="${escapeHtml(post.username)}">
          <span class="reel-author-name" onclick="window.openUserProfile('${escapeHtml(post.username)}')">${escapeHtml(post.username)}</span>
          ${post.is_verified_pro || post.user_role === 'professional' ? '<span class="text-[11px]">✓</span>' : ''}
        </div>
        <p class="reel-caption">${formatCaption(escapeHtml(post.description || ''))}</p>
        ${post.location ? `<span class="reel-spot" onclick="window.searchLocation('${escapeHtml(post.location)}')">? ${escapeHtml(cleanLocationDisplay(post.location))}</span>` : ''}
      </div>

      <div class="reel-side-actions">
        <button class="reel-action-btn ${post.isLiked ? 'liked' : ''}" data-reel-like="${post.id}">
          <span>${post.isLiked ? '♥' : '♡'}</span>
          <span class="reel-like-count">${post.likes || 0}</span>
        </button>
        <button class="reel-action-btn" data-reel-comment="${post.id}">
          <span>◦</span>
          <span>${(post.comments || []).length}</span>
        </button>
        <button class="reel-action-btn" data-reel-share="${post.id}">
          <span>↗</span>
          <span>Share</span>
        </button>
      </div>
    `;

    const likeBtn = card.querySelector(`[data-reel-like="${post.id}"]`);
    likeBtn.addEventListener('click', async () => {
      if (!requireAuth('like spots')) return;
      const wasLiked = likeBtn.classList.contains('liked');
      const next = Math.max(0, (post.likes || 0) + (wasLiked ? -1 : 1));
      try {
        const res = await api(`/posts/${post.id}/like`, {
          method: 'POST',
          body: JSON.stringify({ user_id: currentUser.id })
        });
        post.isLiked = !wasLiked;
        post.likes = (res && typeof res.likes === 'number') ? res.likes : next;
        likeBtn.classList.toggle('liked', post.isLiked);
        likeBtn.querySelector('span').textContent = post.isLiked ? '♥' : '♡';
        likeBtn.querySelector('.reel-like-count').textContent = post.likes;
      } catch (err) {
        showToast('Could not save that like. Please try again.');
      }
    });

    card.querySelector(`[data-reel-comment="${post.id}"]`).addEventListener('click', () => {
      openFullCommentsModal(post.id);
    });

    card.querySelector(`[data-reel-share="${post.id}"]`).addEventListener('click', () => {
      openShareModal(post.id);
    });

    container.appendChild(card);
  });

  // Only play the reel that is on screen.
  if (reelsObserver) reelsObserver.disconnect();
  reelsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const video = entry.target.querySelector('video');
      if (!video) return;
      if (entry.isIntersecting) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, { threshold: 0.6 });

  container.querySelectorAll('.reel-card').forEach(card => reelsObserver.observe(card));
}

// ============================================================
// 8. Search
// ============================================================
function initSearch() {
  const searchInput = document.getElementById('searchInput');
  const searchDrawer = document.getElementById('searchDrawer');
  const navSearch = document.getElementById('navSearch');
  const closeSearch = document.getElementById('closeSearchDrawer');
  const feedSearchForm = document.getElementById('feedSearchForm');
  const feedSearchInput = document.getElementById('feedSearchInput');

  if (navSearch && searchDrawer && searchInput) navSearch.addEventListener('click', () => {
    searchDrawer.classList.toggle('open');
    if (searchDrawer.classList.contains('open')) {
      searchInput.focus();
      renderSearchResults(searchInput.value.trim());
    }
  });

  if (closeSearch && searchDrawer) closeSearch.addEventListener('click', () => searchDrawer.classList.remove('open'));

  let debounce = null;
  if (searchInput) searchInput.addEventListener('input', (e) => {
    clearTimeout(debounce);
    const value = e.target.value.trim();
    debounce = setTimeout(() => renderSearchResults(value), 220);
  });

  if (searchInput) searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applySearch(e.target.value.trim());
    }
  });

  if (feedSearchForm && feedSearchInput) {
    feedSearchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = feedSearchInput.value.trim();
      if (query) applySearch(query);
      else feedSearchInput.focus();
    });

    feedSearchInput.addEventListener('input', () => {
      searchInput.value = feedSearchInput.value;
      searchDrawer.classList.add('open');
      clearTimeout(debounce);
      const value = feedSearchInput.value.trim();
      debounce = setTimeout(() => renderSearchResults(value), 220);
    });
  }
}

function applySearch(query) {
  if (!query) return;
  searchQuery = query;
  const drawerInput = document.getElementById('searchInput');
  const feedInput = document.getElementById('feedSearchInput');
  if (drawerInput) drawerInput.value = query;
  if (feedInput) feedInput.value = query;
  currentFilter = 'all';
  resetFilterPills();
  renderLimit = 12;
  setView('home', document.getElementById('navHome'));
  renderFeed(query);
  document.getElementById('searchDrawer').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.searchLocation = function (loc) {
  const cleanLoc = String(loc).replace(/^⌖\s*/, '').replace(/^#\s*/, '').trim();
  const navHome = document.getElementById('navHome');
  if (navHome) navHome.click();
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = cleanLoc;
  applySearch(cleanLoc);
  showToast(`Showing spots for "${cleanLoc}"`);
};

// Live results inside the search drawer: people and places.
async function renderSearchResults(query) {
  const peopleList = document.getElementById('searchPeopleList');
  const placesList = document.getElementById('searchPlacesList');

  if (!query) {
    if (peopleList) peopleList.innerHTML = '<p class="text-[11px] text-white/45 py-1">Type a name to find travelers.</p>';
    if (placesList) placesList.innerHTML = '<p class="text-[11px] text-white/45 py-1">Type a place to find spots.</p>';
    return;
  }

  const q = query.toLowerCase();

  // Places that actually have spots
  const places = allPosts
    .map(p => ({ post: p, place: cleanLocationDisplay(p.location) }))
    .filter(item => item.place && item.place !== 'Secret Spot' && item.place.toLowerCase().includes(q))
    .filter((item, i, arr) => arr.findIndex(x => x.place.toLowerCase() === item.place.toLowerCase()) === i);

  if (placesList) {
    placesList.innerHTML = places.length
      ? places.slice(0, 6).map(item => `
          <div class="search-result-row" data-place="${escapeHtml(item.place)}">
            <span class="search-result-icon">⌖</span>
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold text-white truncate">${escapeHtml(item.place)}</div>
              <div class="text-[10px] text-white/50">${item.post.location ? 'Has published spots' : ''}</div>
            </div>
          </div>`).join('')
      : '<p class="text-[11px] text-white/45 py-1">No places match that search.</p>';

    placesList.querySelectorAll('[data-place]').forEach(row => {
      row.addEventListener('click', () => applySearch(row.getAttribute('data-place')));
    });
  }

  // People
  let people = [];
  try {
    people = await api(`/users/search?user_id=${currentUser.id}&q=${encodeURIComponent(query)}`) || [];
  } catch (err) {
    people = [];
  }

  if (peopleList) {
    peopleList.innerHTML = people.length
      ? people.map(p => `
          <div class="search-result-row" data-username="${escapeHtml(p.username)}">
            <img src="${escapeHtml(p.avatar)}" class="search-result-avatar" alt="${escapeHtml(p.username)}">
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold text-white truncate">${escapeHtml(p.username)} ${p.is_verified_pro ? '✓' : ''}</div>
              <div class="text-[10px] text-white/50 truncate">${escapeHtml(p.name)}${p.posts_count ? ` • ${p.posts_count} spots` : ''}</div>
            </div>
            <button class="follow-pill-btn ${p.isFollowing ? 'following' : ''}" data-userid="${p.id}" data-username="${encodeURIComponent(p.username)}">
              ${p.isFollowing ? 'Following' : 'Follow'}
            </button>
          </div>`).join('')
      : '<p class="text-[11px] text-white/45 py-1">No travelers match that search.</p>';

    peopleList.querySelectorAll('[data-username]').forEach(el => {
      if (el.classList.contains('follow-pill-btn')) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          handleFollowToggle(el.getAttribute('data-userid'),
            decodeURIComponent(el.getAttribute('data-username')), el);
        });
      } else {
        el.addEventListener('click', () => {
          document.getElementById('searchDrawer').classList.remove('open');
          showUserProfileModal(el.getAttribute('data-username'));
        });
      }
    });
  }
}

// Trending destinations for the search drawer (real destinations only)
async function loadDestinations() {
  const list = document.getElementById('popularDestinationsList');
  if (!list) return;
  try {
    const destinations = await api('/destinations') || [];
    list.innerHTML = destinations.length
      ? destinations.slice(0, 8).map(d => `
          <div class="search-result-row" data-place="${escapeHtml(d.name)}">
            <span class="search-result-icon">⌖</span>
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold text-white truncate">${escapeHtml(d.name)}</div>
              <div class="text-[10px] text-white/50">${d.count} spot${d.count === 1 ? '' : 's'}</div>
            </div>
          </div>`).join('')
      : '<p class="text-[11px] text-white/45 py-1">No destinations yet. They appear as spots are published.</p>';

    list.querySelectorAll('[data-place]').forEach(row => {
      row.addEventListener('click', () => applySearch(row.getAttribute('data-place')));
    });
  } catch (err) {
    list.innerHTML = '<p class="text-[11px] text-white/45 py-1">Could not load destinations.</p>';
  }
}

// Trending tags & locations for the sidebar widget
async function loadTrending() {
  const tagsList = document.getElementById('trendingTagsList');
  const locList = document.getElementById('trendingLocationsList');
  if (!tagsList && !locList) return;

  try {
    const data = await api('/trending') || { tags: [], locations: [] };

    if (tagsList) {
      tagsList.innerHTML = data.tags.length
        ? data.tags.map(t => `
            <div class="flex justify-between items-center py-1 border-b border-white/5">
              <span class="font-medium hover:text-[#d2a35c] cursor-pointer" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</span>
              <span class="text-white/50 text-[11px]">${t.count} spot${t.count === 1 ? '' : 's'}</span>
            </div>`).join('')
        : '<p class="text-[11px] text-white/45 py-1">No trending tags yet. They appear as travelers post.</p>';

      tagsList.querySelectorAll('[data-tag]').forEach(el => {
        el.addEventListener('click', () => applySearch(el.getAttribute('data-tag')));
      });
    }

    if (locList) {
      locList.innerHTML = data.locations.length
        ? data.locations.map(l => `
            <div class="flex justify-between items-center py-1 border-b border-white/5">
              <span class="font-medium hover:text-[#d2a35c] cursor-pointer" data-loc="${escapeHtml(l.location)}">${escapeHtml(l.location)}</span>
              <span class="text-white/50 text-[11px]">${l.count} spot${l.count === 1 ? '' : 's'}</span>
            </div>`).join('')
        : '<p class="text-[11px] text-white/45 py-1">No popular destinations yet.</p>';

      locList.querySelectorAll('[data-loc]').forEach(el => {
        el.addEventListener('click', () => applySearch(el.getAttribute('data-loc')));
      });
    }
  } catch (err) {
    if (tagsList) tagsList.innerHTML = '<p class="text-[11px] text-white/45 py-1">Could not load trending tags.</p>';
    if (locList) locList.innerHTML = '<p class="text-[11px] text-white/45 py-1">Could not load trending places.</p>';
  }
}

// ============================================================
// 9. Create post wizard
// ============================================================
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function setPostMediaFiles(fileList) {
  const files = Array.from(fileList || []);
  const status = document.getElementById('uploadSelectionStatus');
  const error = document.getElementById('mediaErrorMsg');
  const validImages = files.filter(file => file.type.startsWith('image/'));
  const totalBytes = validImages.reduce((sum, file) => sum + file.size, 0);

  if (!validImages.length) {
    if (error) {
      error.textContent = 'Choose at least one image file.';
      error.classList.remove('hidden');
    }
    return;
  }
  if (files.length > 8 || validImages.length !== files.length || totalBytes > 30 * 1024 * 1024) {
    if (error) {
      error.textContent = 'Choose up to 8 image files with a combined size under 30 MB.';
      error.classList.remove('hidden');
    }
    return;
  }

  try {
    const media = await Promise.all(validImages.map(readFileAsDataUrl));
    base64MediaList = media;
    const preview = document.getElementById('mediaPreview');
    const filterPreviewImg = document.getElementById('filterPreviewImg');
    if (preview) {
      preview.src = media[0];
      preview.classList.remove('hidden');
    }
    if (filterPreviewImg) filterPreviewImg.src = media[0];
    if (status) status.textContent = `${validImages.length} photo${validImages.length === 1 ? '' : 's'} ready to share`;
    if (error) error.classList.add('hidden');
  } catch (err) {
    if (error) {
      error.textContent = 'The selected photo could not be read. Try another file.';
      error.classList.remove('hidden');
    }
  }
}

function initCreatePostWizard() {
  const closeBtn = document.getElementById('closeCreateModal');
  const cancelBtn = document.getElementById('wizardCancelBtn');
  const nextBtn = document.getElementById('wizardNextBtn');
  const prevBtn = document.getElementById('wizardPrevBtn');
  const submitBtn = document.getElementById('wizardSubmitBtn');
  const form = document.getElementById('createPostForm');

  const mediaInput = document.getElementById('postMediaFile');
  const mediaUrl = document.getElementById('postMediaUrl');
  const mediaPreview = document.getElementById('mediaPreview');
  const filterPreviewImg = document.getElementById('filterPreviewImg');

  const uploadArea = mediaInput.parentElement;
  mediaInput.addEventListener('change', (e) => setPostMediaFiles(e.target.files));
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('upload-drop-active');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('upload-drop-active'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('upload-drop-active');
    setPostMediaFiles(e.dataTransfer.files);
  });

  mediaUrl.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      base64MediaList = [val];
      mediaPreview.src = val;
      mediaPreview.classList.remove('hidden');
      filterPreviewImg.src = val;
    }
  });

  document.querySelectorAll('.filter-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-choice-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      activeFilterCss = btn.getAttribute('data-filter');
      filterPreviewImg.style.filter = activeFilterCss;
      mediaPreview.style.filter = activeFilterCss;
    });
  });

  // GPS uses the real device position. No hardcoded fallback location.
  const gpsBtn = document.getElementById('getLocationBtn');
  const locationInput = document.getElementById('postLocation');
  gpsBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      showToast('This browser cannot share your location.');
      return;
    }
    gpsBtn.textContent = 'Locating...';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude.toFixed(5);
      const lon = pos.coords.longitude.toFixed(5);
      const coords = `${lat}, ${lon}`;
      gpsBtn.textContent = 'Resolving place...';

      // Attach a human-readable place name so the hazard dashboard can match
      // the post when someone searches by city. Coordinates alone still work.
      let placeName = '';
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        if (response.ok) {
          const data = await response.json();
          const a = data.address || {};
          placeName = a.city || a.town || a.village || a.county || a.state || '';
          if (!placeName && data.display_name) placeName = data.display_name.split(',').slice(0, 2).join(',').trim();
        }
      } catch (err) {
        console.warn('Reverse geocoding unavailable:', err.message);
      }

      locationInput.value = placeName ? `${placeName} — ${coords}` : coords;
      gpsBtn.textContent = 'GPS set';
      setTimeout(() => { gpsBtn.textContent = '⌖ GPS'; }, 2000);
    }, () => {
      gpsBtn.textContent = '⌖ GPS';
      showToast('Location permission denied. Type the place name instead.');
    });
  });

  closeBtn.onclick = closeCreateModal;
  cancelBtn.onclick = closeCreateModal;

  nextBtn.onclick = () => {
    if (currentWizardStep === 1) {
      const errEl = document.getElementById('mediaErrorMsg');
      if (base64MediaList.length === 0) {
        if (errEl) errEl.classList.remove('hidden');
        return;
      }
      if (errEl) errEl.classList.add('hidden');
    }

    if (currentWizardStep === 3) {
      const loc = locationInput.value.trim();
      const errEl = document.getElementById('locationErrorMsg');
      if (!loc) {
        errEl.classList.remove('hidden');
        return;
      }
      errEl.classList.add('hidden');
    }

    if (currentWizardStep < totalWizardSteps) {
      currentWizardStep++;
      updateWizardSteps();
    }
  };

  prevBtn.onclick = () => {
    if (currentWizardStep > 1) {
      currentWizardStep--;
      updateWizardSteps();
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireAuth('publish spots')) return;

    const locationVal = locationInput.value.trim();
    if (!locationVal) {
      showToast('Please add the location of the spot.');
      return;
    }
    if (base64MediaList.length === 0) {
      showToast('Please add a photo for the spot.');
      return;
    }

    submitBtn.textContent = 'Publishing...';
    submitBtn.disabled = true;

    const postPayload = {
      id: Date.now(),
      user_id: currentUser.id,
      username: currentUser.username,
      author_avatar: currentUser.avatar,
      is_verified_pro: currentUser.is_verified_pro,
      location: locationVal,
      media: base64MediaList[0],
      carousel_media: base64MediaList.length > 1 ? base64MediaList : [],
      filter_css: activeFilterCss,
      description: document.getElementById('postDescription').value,
      hotel_name: document.getElementById('postHotelName').value,
      hotel_contact: document.getElementById('postHotelContact').value,
      hotel_feedback: document.getElementById('postHotelFeedback').value,
      transport_type: document.getElementById('postTransportType').value,
      transport_price: document.getElementById('postTransportPrice').value,
      transport_contact: document.getElementById('postTransportContact').value,
      route_desc: document.getElementById('postRouteDesc').value,
      route_cost: '',
      food_place: document.getElementById('postFoodPlace').value,
      food_price: document.getElementById('postFoodPrice').value,
      must_visit_name: document.getElementById('postMustVisitName').value,
      likes: 0,
      comments: [],
      created_at: new Date().toISOString()
    };

    let published = false;
    try {
      const saved = await api('/posts', { method: 'POST', body: JSON.stringify(postPayload) });
      published = true;
      postPayload.id = saved.id || postPayload.id;
      if (saved.ai_audit) {
        postPayload.ai_trust_score = saved.ai_audit.trustScore;
        postPayload.is_ai_altered = saved.ai_audit.isAiAltered;
        postPayload.ai_alteration_note = saved.ai_audit.alterationNote;
        postPayload.promotion_status = saved.ai_audit.promotionStatus;
        postPayload.promotion_reason = saved.ai_audit.promotionReason;
        postPayload.ai_badge = saved.ai_audit.badge;
      }
      showToast('Spot shared to the feed');
    } catch (err) {
      console.error('MongoDB did not save the new spot:', err);
      showToast('Could not publish this spot. Check the server connection and try again.');
    } finally {
      closeCreateModal();
      form.reset();
      base64MediaList = [];
      const uploadStatus = document.getElementById('uploadSelectionStatus');
      if (uploadStatus) uploadStatus.textContent = 'JPG, PNG or WebP · up to 30 MB total';
      activeFilterCss = 'none';
      mediaPreview.classList.add('hidden');
      mediaPreview.style.filter = '';
      filterPreviewImg.style.filter = '';
      document.querySelectorAll('.filter-choice-btn').forEach(b => b.classList.remove('selected'));
      const noneBtn = document.querySelector('.filter-choice-btn[data-filter="none"]');
      if (noneBtn) noneBtn.classList.add('selected');
      if (published) allPosts.unshift(postPayload);
      renderLimit = 12;
      setView('home', document.getElementById('navHome'));
      if (published) renderFeed();
      submitBtn.textContent = 'Share Spot';
      submitBtn.disabled = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (published) loadPosts();
    }
  });
}

function openCreateModal() {
  currentWizardStep = 1;
  updateWizardSteps();
  const modal = document.getElementById('createPostModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeCreateModal() {
  const modal = document.getElementById('createPostModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function updateWizardSteps() {
  for (let i = 1; i <= totalWizardSteps; i++) {
    const stepEl = document.getElementById(`step${i}`);
    if (stepEl) {
      stepEl.classList.toggle('hidden', i !== currentWizardStep);
      stepEl.classList.toggle('block', i === currentWizardStep);
    }
  }

  const title = document.getElementById('wizardTitle');
  const prevBtn = document.getElementById('wizardPrevBtn');
  const nextBtn = document.getElementById('wizardNextBtn');
  const submitBtn = document.getElementById('wizardSubmitBtn');

  title.textContent = `Create New Spot Post (Step ${currentWizardStep}/${totalWizardSteps})`;
  prevBtn.classList.toggle('invisible', currentWizardStep === 1);

  if (currentWizardStep === totalWizardSteps) {
    nextBtn.classList.add('hidden');
    submitBtn.classList.remove('hidden');
  } else {
    nextBtn.classList.remove('hidden');
    submitBtn.classList.add('hidden');
  }
}

// ============================================================
// 10. Direct messages
// ============================================================
async function initDirectMessages() {
  const sidebar = document.getElementById('chatSidebar');
  const navMsg = document.getElementById('navMessages');
  const closeBtn = document.getElementById('closeChatBtn');
  const sendForm = document.getElementById('dmSendForm');
  const inputField = document.getElementById('dmInputField');

  if (navMsg && sidebar) navMsg.addEventListener('click', () => {
    sidebar.style.right = '0';
    loadDMThreads();
  });

  if (closeBtn && sidebar) closeBtn.addEventListener('click', () => {
    sidebar.style.right = '-380px';
  });

  if (sendForm && inputField) sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = inputField.value.trim();
    if (!text) return;
    if (!requireAuth('send messages')) return;
    if (!activeDMPeer) {
      showToast('Pick a traveler to message first.');
      return;
    }
    await sendDirectMessage(activeDMPeer, text);
    inputField.value = '';
  });
}

async function sendDirectMessage(peer, text, postId = null) {
  try {
    const saved = await api('/messages', {
      method: 'POST',
      body: JSON.stringify({
        from_user_id: currentUser.id,
        from_username: currentUser.username,
        to_username: peer,
        text,
        post_id: postId
      })
    });
    appendOutgoingMessage(saved);
    loadDMThreads({ force: true });
    return saved;
  } catch (err) {
    showToast('Could not send the message.');
    return null;
  }
}

async function loadDMThreads({ force = false } = {}) {
  const threadList = document.getElementById('chatThreadList');
  if (!threadList) return;

  if (isGuest) {
    threadList.innerHTML = '<p class="text-[11px] text-white/50 py-2 px-1">Log in to start a conversation.</p>';
    updateMessageBadge(0);
    return;
  }

  const userId = String(currentUser.id);
  if (dmThreadsRequest) return dmThreadsRequest;
  if (!force && dmThreadsLoadedForUserId === userId && Date.now() - dmThreadsLoadedAt < 15000) {
    renderDMThreads();
    return;
  }

  threadList.innerHTML = '<p class="text-[11px] text-white/50 py-2 px-1">Loading conversations…</p>';
  dmThreadsRequest = api(`/messages/threads?user_id=${encodeURIComponent(userId)}`)
    .then(threads => {
      dmThreads = threads || [];
      dmThreadsLoadedForUserId = userId;
      dmThreadsLoadedAt = Date.now();
      renderDMThreads();
    })
    .catch(err => {
      console.warn('Could not load conversations:', err);
      dmThreads = [];
      threadList.innerHTML = '<p class="text-[11px] text-white/50 py-2 px-1">Could not load conversations. Tap Messages to retry.</p>';
    })
    .finally(() => { dmThreadsRequest = null; });
  return dmThreadsRequest;
}

function renderDMThreads() {
  const threadList = document.getElementById('chatThreadList');
  if (!threadList) return;

  const unread = dmThreads.filter(t => t.unread).length;
  updateMessageBadge(unread);

  if (dmThreads.length === 0) {
    threadList.innerHTML = '<p class="text-[11px] text-white/50 py-2 px-1">No conversations yet.</p>';
    return;
  }

  threadList.innerHTML = dmThreads.map(t => `
    <button class="dm-thread-item ${activeDMPeer === t.peer_username ? 'active' : ''}" data-peer="${escapeHtml(t.peer_username)}">
      <img src="${escapeHtml(t.peer_avatar)}" class="dm-thread-avatar" alt="${escapeHtml(t.peer_username)}">
      <div class="flex-1 min-w-0 text-left">
        <div class="text-xs font-bold text-white truncate">${escapeHtml(t.peer_username)}</div>
        <div class="text-[10px] text-white/50 truncate">${escapeHtml(t.last_message || '')}</div>
      </div>
      ${t.unread ? '<span class="dm-unread-dot"></span>' : ''}
    </button>
  `).join('');

  threadList.querySelectorAll('.dm-thread-item').forEach(btn => {
    btn.addEventListener('click', () => openDMThread(btn.getAttribute('data-peer')));
  });
}

async function openDMThread(peer) {
  if (!requireAuth('send messages')) return;
  activeDMPeer = peer;

  document.querySelectorAll('.dm-thread-item').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-peer') === peer);
  });

  const activeAuthor = document.getElementById('chatAuthorHeader');
  if (activeAuthor) activeAuthor.textContent = peer;

  const chatList = document.getElementById('chatList');
  chatList.innerHTML = '<p class="text-xs text-white/50 text-center py-4">Loading messages...</p>';

  try {
    const messages = await api(`/messages/thread?user_id=${currentUser.id}&peer=${encodeURIComponent(peer)}`) || [];
    chatList.innerHTML = '';

    if (messages.length === 0) {
      chatList.innerHTML = `<p id="chatEmptyState" class="text-xs text-white/50 text-center py-6">No messages yet. Say hello to ${escapeHtml(peer)}.</p>`;
    } else {
      messages.forEach(msg => {
        const mine = msg.from_username === currentUser.username;
        const bubble = document.createElement('div');
        bubble.className = mine
          ? 'bg-[#d2a35c]/20 border border-[#d2a35c]/40 p-3 rounded-2xl rounded-tr-sm w-4/5 ml-auto text-xs text-white'
          : 'dm-bubble-in';
        bubble.innerHTML = `<p class="leading-relaxed">${escapeHtml(msg.text)}</p>
          <div class="dm-bubble-time">${getRelativeTime(msg.created_at)}</div>`;
        chatList.appendChild(bubble);
      });
    }
    chatList.scrollTop = chatList.scrollHeight;
    dmThreads = dmThreads.map(thread => thread.peer_username === peer
      ? { ...thread, unread: false }
      : thread);
    dmThreadsLoadedAt = Date.now();
    renderDMThreads();
  } catch (err) {
    chatList.innerHTML = '<p class="text-xs text-white/50 text-center py-6">Could not load this conversation.</p>';
  }
}

function appendOutgoingMessage(msg) {
  const chatList = document.getElementById('chatList');
  if (!chatList) return;
  const emptyState = document.getElementById('chatEmptyState');
  if (emptyState) emptyState.remove();

  const bubble = document.createElement('div');
  bubble.className = 'bg-[#d2a35c]/20 border border-[#d2a35c]/40 p-3 rounded-2xl rounded-tr-sm w-4/5 ml-auto text-xs text-white';
  bubble.innerHTML = `<p class="leading-relaxed">${escapeHtml(msg.text)}</p>
    <div class="dm-bubble-time">${getRelativeTime(msg.created_at)}</div>`;
  chatList.appendChild(bubble);
  chatList.scrollTop = chatList.scrollHeight;
}

function updateMessageBadge(count) {
  ['unreadMsgBadge', 'mobUnreadMsgBadge'].forEach(id => {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', !count);
  });
}

// ============================================================
// 11. AI trust report
// ============================================================
function initAiTrustModal() {
  const modal = document.getElementById('aiTrustModal');
  const closeBtn = document.getElementById('closeAiTrustModalBtn');
  const closeBtn2 = document.getElementById('closeTrustDetailsBtn');

  const close = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
  closeBtn.onclick = close;
  closeBtn2.onclick = close;

  window.openAiTrustDetails = function (postId) {
    const post = allPosts.find(p => String(p.id) === String(postId));
    if (!post) return;

    const content = document.getElementById('aiTrustModalContent');
    content.innerHTML = `
      <div class="bg-white/5 p-3.5 rounded-2xl border border-white/10 space-y-2">
        <div class="flex justify-between items-center">
          <span class="text-white/70">Author Credential:</span>
          <span class="text-[#d2a35c] font-bold">${post.is_verified_pro ? '&#x2713; Creator verified' : '&#x2659; Community member'}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-white/70">Optical Sensor Audit:</span>
          <span class="${post.is_ai_altered ? 'text-red-400' : 'text-emerald-400'} font-bold">
            ${post.is_ai_altered ? 'Alteration signal flagged' : 'No alteration flags'}
          </span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-white/70">Integrity Score:</span>
          <span class="text-emerald-300 font-mono font-bold">${post.ai_trust_score != null ? `${post.ai_trust_score}%` : 'Not scanned'}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-white/70">Promotion Sentiment:</span>
          <span class="text-amber-300 font-semibold">${escapeHtml(post.promotion_status || 'Not scanned')}</span>
        </div>
      </div>
      <p class="text-[11px] text-white/70 leading-relaxed">
        <strong>Engine Audit Note:</strong> ${escapeHtml(post.ai_alteration_note || 'No integrity scan has been run for this post yet.')}
      </p>
    `;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  };
}

// ============================================================
// 12. Modals (action sheet, new story, trust policy)
// ============================================================
function initModals() {
  const sheet = document.getElementById('postActionSheet');
  const sheetShareBtn = document.getElementById('sheetShareBtn');
  const sheetSaveBtn = document.getElementById('sheetSaveBtn');
  const sheetAuditBtn = document.getElementById('sheetAuditBtn');
  const sheetHideBtn = document.getElementById('sheetHideBtn');
  const sheetReportBtn = document.getElementById('sheetReportBtn');
  const sheetDeleteBtn = document.getElementById('sheetDeleteBtn');
  const sheetCancelBtn = document.getElementById('sheetCancelBtn');

  function closeSheet() {
    sheet.classList.add('hidden');
    activePostMenuId = null;
  }

  sheetCancelBtn.onclick = closeSheet;
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };

  sheetShareBtn.onclick = () => {
    if (activePostMenuId) openShareModal(activePostMenuId);
    closeSheet();
  };

  sheetSaveBtn.onclick = () => {
    if (activePostMenuId) {
      const saveBtn = document.getElementById(`save-btn-${activePostMenuId}`);
      if (saveBtn) handleSaveToggle(activePostMenuId, saveBtn);
    }
    closeSheet();
  };

  sheetAuditBtn.onclick = () => {
    if (activePostMenuId) openAiTrustDetails(activePostMenuId);
    closeSheet();
  };

  sheetHideBtn.onclick = () => {
    if (activePostMenuId) handleHidePost(activePostMenuId);
    closeSheet();
  };

  sheetReportBtn.onclick = () => {
    if (activePostMenuId) handleReportPost(activePostMenuId);
    closeSheet();
  };

  sheetDeleteBtn.onclick = () => {
    if (activePostMenuId) handleDeletePost(activePostMenuId);
    closeSheet();
  };

  // Quick Story Modal
  const storyModal = document.getElementById('storyCreateModal');
  const closeStoryModal = document.getElementById('closeStoryCreateModal');
  const submitStoryBtn = document.getElementById('submitNewStoryBtn');

  closeStoryModal.onclick = () => { storyModal.classList.add('hidden'); storyModal.classList.remove('flex'); };

  submitStoryBtn.onclick = async () => {
    if (!requireAuth('post a story')) return;

    const spot = document.getElementById('newStorySpot').value.trim();
    const media = document.getElementById('newStoryMedia').value.trim();
    const caption = document.getElementById('newStoryCaption').value.trim();

    if (!media) {
      showToast('Add a photo to your story (upload a file or paste an image URL).');
      return;
    }

    const newStoryItem = {
      user_id: currentUser.id,
      username: currentUser.username,
      name: currentUser.name,
      avatar: currentUser.avatar,
      is_verified_pro: currentUser.is_verified_pro,
      spot,
      media,
      caption
    };

    try {
      const saved = await api('/stories', { method: 'POST', body: JSON.stringify(newStoryItem) });
      newStoryItem.id = saved.id;
      newStoryItem.created_at = saved.created_at;
      newStoryItem.time = 'Just now';
    } catch (e) {
      console.warn('Story could not be published:', e);
      showToast('Could not publish the story. Please try again.');
      return;
    }

    stories.unshift(newStoryItem);
    storyModal.classList.add('hidden');
    storyModal.classList.remove('flex');
    document.getElementById('newStorySpot').value = '';
    document.getElementById('newStoryMedia').value = '';
    document.getElementById('newStoryCaption').value = '';
    const preview = document.getElementById('storyMediaPreview');
    if (preview) preview.classList.add('hidden');
    const placeholder = document.getElementById('storyUploadPlaceholder');
    if (placeholder) placeholder.classList.remove('hidden');
    showToast('Your 24-hour spot story is live');
    renderStoriesTray();
  };

  // Trust Policy Modal
  const trustModal = document.getElementById('trustPolicyModal');
  const openTrustBtn = document.getElementById('openTrustPolicyBtn');
  const trustFooterLink = document.getElementById('trustFooterLink');
  const closeTrustModal = document.getElementById('closeTrustPolicyModal');
  const ackTrustBtn = document.getElementById('acknowledgeTrustBtn');

  const openTrust = () => { trustModal.classList.remove('hidden'); trustModal.classList.add('flex'); };
  const closeTrust = () => { trustModal.classList.add('hidden'); trustModal.classList.remove('flex'); };

  if (openTrustBtn) openTrustBtn.onclick = openTrust;
  if (trustFooterLink) trustFooterLink.onclick = (e) => { e.preventDefault(); openTrust(); };
  if (closeTrustModal) closeTrustModal.onclick = closeTrust;
  if (ackTrustBtn) ackTrustBtn.onclick = closeTrust;

  // See All / Show Less suggestions
  const seeAllBtn = document.getElementById('seeAllSuggestionsBtn');
  if (seeAllBtn) {
    seeAllBtn.onclick = () => {
      const expanded = seeAllBtn.dataset.expanded === 'true';
      seeAllBtn.dataset.expanded = expanded ? 'false' : 'true';
      seeAllBtn.textContent = expanded ? 'See All' : 'Show Less';
      loadSuggestions(expanded ? 5 : 50);
    };
  }
}

// ============================================================
// 13. Notifications drawer
// ============================================================
function initNotificationsDrawer() {
  const navNotif = document.getElementById('navNotifications');
  const drawer = document.getElementById('notificationsDrawer');
  const closeBtn = document.getElementById('closeNotificationsDrawer');
  const markAllBtn = document.getElementById('markAllReadBtn');

  if (navNotif && drawer) {
    navNotif.addEventListener('click', () => {
      drawer.classList.toggle('open');
      if (drawer.classList.contains('open')) loadNotifications();
    });
  }

  if (closeBtn && drawer) {
    closeBtn.addEventListener('click', () => drawer.classList.remove('open'));
  }

  if (markAllBtn) {
    markAllBtn.onclick = async () => {
      if (notifications.length === 0) return;
      const keys = notifications.map(n => n.key);
      try {
        await api('/notifications/read', {
          method: 'POST',
          body: JSON.stringify({ user_id: currentUser.id, keys })
        });
        notifications.forEach(n => { n.is_read = true; });
        renderNotifications();
        updateNotificationBadge(0);
        showToast('All notifications marked as read');
      } catch (err) {
        showToast('Could not mark the notifications as read.');
      }
    };
  }
}

async function loadNotifications() {
  const list = document.getElementById('notificationsList');
  if (!list) return;

  if (isGuest) {
    list.innerHTML = '<p class="text-xs text-white/50 text-center py-6">Log in to see activity on your spots.</p>';
    updateNotificationBadge(0);
    return;
  }

  try {
    notifications = await api(`/notifications?user_id=${currentUser.id}`) || [];
  } catch (err) {
    console.warn('Could not load notifications:', err);
    notifications = [];
  }

  renderNotifications();
  updateNotificationBadge(notifications.filter(n => !n.is_read).length);
}

function renderNotifications() {
  const list = document.getElementById('notificationsList');
  if (!list) return;

  if (notifications.length === 0) {
    list.innerHTML = '<p class="text-xs text-white/50 text-center py-6">No activity yet. Likes, comments, follows and messages on your spots will appear here.</p>';
    return;
  }

  const icons = { like: '♥', comment: '◦', follow: '♙', message: '✉' };

  list.innerHTML = notifications.map(n => `
    <div class="notification-row ${n.is_read ? '' : 'unread'}" data-key="${escapeHtml(n.key)}" data-post="${n.post_id || ''}" data-user="${escapeHtml(n.actor_username)}">
      <img src="${escapeHtml(n.actor_avatar)}" class="notification-avatar" alt="${escapeHtml(n.actor_username)}">
      <div class="notification-body">
        <div class="notification-text">
          ${icons[n.type] || '✦'} <strong>${escapeHtml(n.actor_username)}</strong> ${escapeHtml(n.text)}
        </div>
        <div class="notification-time">${getRelativeTime(n.created_at)}</div>
      </div>
      ${n.is_read ? '' : '<span class="notification-unread-dot"></span>'}
    </div>
  `).join('');

  list.querySelectorAll('.notification-row').forEach(row => {
    row.addEventListener('click', async () => {
      const key = row.getAttribute('data-key');
      const notif = notifications.find(n => n.key === key);
      if (notif) {
        notif.is_read = true;
        try {
          await api('/notifications/read', {
            method: 'POST',
            body: JSON.stringify({ user_id: currentUser.id, keys: [key] })
          });
        } catch (e) { /* keep the UI state even if the write failed */ }
      }
      renderNotifications();
      updateNotificationBadge(notifications.filter(n => !n.is_read).length);

      const postId = row.getAttribute('data-post');
      if (postId) {
        jumpToPost(postId);
      } else {
        showUserProfileModal(row.getAttribute('data-user'));
      }
    });
  });
}

function updateNotificationBadge(count) {
  ['unreadNotifBadge', 'mobUnreadNotifBadge'].forEach(id => {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', !count);
  });
}

// ============================================================
// 14. Profile modal
// ============================================================
function initProfileModal() {
  const modal = document.getElementById('creatorProfileModal');
  const closeBtn = document.getElementById('closeProfileModalBtn');
  const followBtn = document.getElementById('modalProfileFollowBtn');
  const msgBtn = document.getElementById('modalProfileMessageBtn');
  const editBtn = document.getElementById('modalProfileEditBtn');
  const tabPosts = document.getElementById('profileTabPosts');
  const tabSaved = document.getElementById('profileTabSaved');

  if (closeBtn) {
    closeBtn.onclick = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
  }

  if (followBtn) {
    followBtn.addEventListener('click', () => {
      if (!viewedUserProfile) return;
      handleFollowToggle(viewedUserProfile.id, viewedUserProfile.username, followBtn);
    });
  }

  if (msgBtn) {
    msgBtn.addEventListener('click', () => {
      if (!viewedUserProfile) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      const chatSidebar = document.getElementById('chatSidebar');
      if (chatSidebar) chatSidebar.style.right = '0';
      openDMThread(viewedUserProfile.username);
    });
  }

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      openEditProfileModal();
    });
  }

  if (tabPosts) {
    tabPosts.addEventListener('click', () => {
      tabPosts.className = "flex-1 py-3 text-center text-[#d2a35c] border-b-2 border-[#d2a35c] flex items-center justify-center gap-1.5";
      if (tabSaved) tabSaved.className = "flex-1 py-3 text-center hover:text-white flex items-center justify-center gap-1.5";
      renderProfilePosts(viewedUserProfile?.username, false);
    });
  }

  if (tabSaved) {
    tabSaved.addEventListener('click', () => {
      tabSaved.className = "flex-1 py-3 text-center text-[#d2a35c] border-b-2 border-[#d2a35c] flex items-center justify-center gap-1.5";
      if (tabPosts) tabPosts.className = "flex-1 py-3 text-center hover:text-white flex items-center justify-center gap-1.5";
      renderProfilePosts(viewedUserProfile?.username, true);
    });
  }
}

async function showUserProfileModal(username) {
  const modal = document.getElementById('creatorProfileModal');
  if (!modal) return;
  const isOwn = username === currentUser.username;

  let user = isOwn ? { ...currentUser } : null;

  if (!user) {
    try {
      const profile = await api(`/users/profile?username=${encodeURIComponent(username)}`);
      user = profile;
    } catch (err) {
      // Fall back to what the feed already knows about this creator.
      const postWithUser = allPosts.find(p => p.username === username);
      user = postWithUser ? {
        id: postWithUser.user_id,
        username: postWithUser.username,
        name: postWithUser.author_name || postWithUser.username,
        avatar: postWithUser.author_avatar,
        is_verified_pro: postWithUser.is_verified_pro,
        bio: ''
      } : {
        id: null,
        username,
        name: username,
        avatar: avatarFor(username),
        is_verified_pro: false,
        bio: ''
      };
    }
  }

  viewedUserProfile = user;

  const avatarEl = document.getElementById('modalProfileAvatar');
  const usernameEl = document.getElementById('modalProfileUsername');
  const badgeEl = document.getElementById('modalProfileBadge');
  const nameEl = document.getElementById('modalProfileName');
  const bioEl = document.getElementById('modalProfileBio');
  const followBtn = document.getElementById('modalProfileFollowBtn');
  const msgBtn = document.getElementById('modalProfileMessageBtn');
  const editBtn = document.getElementById('modalProfileEditBtn');
  const postsCountEl = document.getElementById('modalProfilePostsCount');
  const modalUpgradeBtn = document.getElementById('modalProfileUpgradeBtn');

  avatarEl.src = user.avatar || avatarFor(user.username);
  usernameEl.textContent = user.username;
  nameEl.textContent = user.name || user.username;
  bioEl.textContent = user.bio || '';
  badgeEl.style.display = (user.is_verified_pro || user.role === 'professional') ? 'inline-block' : 'none';

  if (isOwn) {
    followBtn.classList.add('hidden');
    msgBtn.classList.add('hidden');
    editBtn.classList.remove('hidden');
    if (modalUpgradeBtn) {
      modalUpgradeBtn.classList.toggle('hidden', !!(currentUser.is_verified_pro || currentUser.role === 'professional'));
    }
  } else {
    followBtn.classList.remove('hidden');
    msgBtn.classList.remove('hidden');
    editBtn.classList.add('hidden');
    if (modalUpgradeBtn) modalUpgradeBtn.classList.add('hidden');
    const isFollowed = allPosts.some(p => p.username === user.username && p.isFollowing);
    followBtn.textContent = isFollowed ? 'Following' : 'Follow';
    followBtn.classList.toggle('following', isFollowed);
  }

  postsCountEl.textContent = (user.posts_count != null
    ? user.posts_count
    : allPosts.filter(p => p.username === user.username).length).toString();

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  loadProfileStats(user.username);
  renderProfilePosts(user.username, false);
}

async function loadProfileStats(username) {
  const followersEl = document.getElementById('modalProfileFollowersCount');
  const followingEl = document.getElementById('modalProfileFollowingCount');
  const vibesEl = document.getElementById('modalProfileVibes');
  if (!followersEl || !followingEl) return;

  try {
    const data = await api(`/users/profile?username=${encodeURIComponent(username)}`);
    followersEl.textContent = String(data.followers_count || 0);
    followingEl.textContent = String(data.following_count || 0);
    if (vibesEl) {
      vibesEl.innerHTML = (data.vibes || [])
        .map(v => `<span class="vibe-tag text-[10px]">${escapeHtml(v)}</span>`)
        .join('');
    }
  } catch (err) {
    console.warn('Could not load profile stats:', err);
  }
}

async function renderProfilePosts(username, onlySaved = false) {
  const grid = document.getElementById('profilePostsGrid');
  if (!grid) return;
  grid.innerHTML = '';

  let posts = allPosts.filter(p => p.username === username);

  if (onlySaved) {
    if (isGuest) {
      grid.innerHTML = '<div class="col-span-3 text-center py-8 text-white/50 text-xs">Log in to see your saved spots.</div>';
      return;
    }
    try {
      posts = await api(`/posts/saved?user_id=${currentUser.id}`) || [];
    } catch (err) {
      posts = allPosts.filter(p => p.isSaved);
    }
  }

  if (posts.length === 0) {
    grid.innerHTML = `<div class="col-span-3 text-center py-8 text-white/50 text-xs">No ${onlySaved ? 'saved spots' : 'posts'} to display.</div>`;
    return;
  }

  posts.forEach(post => {
    const tile = document.createElement('div');
    tile.className = 'explore-grid-tile cursor-pointer';
    const media = getMediaList(post)[0];
    tile.innerHTML = `
      ${media
        ? `<img src="${escapeHtml(media)}" alt="Spot photo">`
        : `<div class="w-full h-full flex items-center justify-center text-xs text-white/40">No photo</div>`}
      <div class="explore-overlay-stats">
        <span>♥ ${post.likes || 0}</span>
        <span>◦ ${(post.comments || []).length}</span>
      </div>
    `;
    tile.addEventListener('click', () => {
      const modal = document.getElementById('creatorProfileModal');
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      jumpToPost(post.id);
    });
    grid.appendChild(tile);
  });
}

window.openUserProfile = function (username) {
  showUserProfileModal(username);
};

// ============================================================
// 15. Share sheet
// ============================================================
function initShareModal() {
  const modal = document.getElementById('sharePostModal');
  const closeBtn = document.getElementById('closeShareModalBtn');
  const copyBtn = document.getElementById('shareActionCopyLink');
  const waBtn = document.getElementById('shareActionWhatsApp');
  const nativeBtn = document.getElementById('shareActionNative');

  if (closeBtn) closeBtn.onclick = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };

  if (copyBtn) {
    copyBtn.onclick = async () => {
      const url = buildShareUrl(activeSharePostId);
      const copied = await copyToClipboard(url);
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      showToast(copied ? 'Spot link copied' : `Copy this link: ${url}`);
    };
  }

  if (waBtn) {
    waBtn.onclick = () => {
      const post = allPosts.find(p => String(p.id) === String(activeSharePostId));
      const text = encodeURIComponent(
        `Check out this spot: ${post?.location || 'Secret Spot'} on "bro said he knows a spot"! ${buildShareUrl(activeSharePostId)}`
      );
      window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    };
  }

  if (nativeBtn) {
    nativeBtn.onclick = async () => {
      const post = allPosts.find(p => String(p.id) === String(activeSharePostId));
      const url = buildShareUrl(activeSharePostId);
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (navigator.share) {
        try {
          await navigator.share({
            title: post?.location || 'Secret Spot',
            text: post?.description || 'Secret spot recommendation on bro said he knows a spot',
            url
          });
        } catch (e) { /* the user dismissed the share sheet */ }
      } else {
        const copied = await copyToClipboard(url);
        showToast(copied ? 'Web Share is not supported here, so the link was copied instead.' : `Copy this link: ${url}`);
      }
    };
  }
}

function buildShareUrl(postId) {
  const base = window.location.origin === 'null'
    ? `${API_URL.replace(/\/api$/, '')}/feed.html`
    : `${window.location.origin}/feed.html`;
  return `${base}#post-${postId}`;
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

async function openShareModal(postId) {
  activeSharePostId = postId;
  const modal = document.getElementById('sharePostModal');
  const contacts = document.getElementById('shareContactsList');

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  if (isGuest) {
    contacts.innerHTML = '<p class="text-[11px] text-white/50 py-3 text-center">Log in to send this spot to a traveler.</p>';
    return;
  }

  let travelers = [];
  try {
    travelers = await api(`/users/suggestions?user_id=${currentUser.id}&limit=20`) || [];
  } catch (err) {
    console.warn('Could not load traveler list for sharing:', err);
  }

  if (!contacts) return;

  if (travelers.length === 0) {
    contacts.innerHTML = '<p class="text-[11px] text-white/50 py-3 text-center">No other travelers yet.</p>';
    return;
  }

  contacts.innerHTML = travelers.map(t => `
    <div class="flex items-center justify-between p-2 rounded-xl hover:bg-white/5 transition-colors">
      <div class="flex items-center gap-2.5">
        <img src="${escapeHtml(t.avatar)}" class="w-8 h-8 rounded-full object-cover" alt="${escapeHtml(t.username)}">
        <div>
          <span class="text-xs font-bold text-white block">${escapeHtml(t.username)}</span>
          <span class="text-[10px] text-white/50">${escapeHtml(t.bio || t.name || 'Traveler')}</span>
        </div>
      </div>
      <button class="px-3 py-1 rounded-full text-xs font-bold bg-[#d2a35c] text-[#070c0a] hover:bg-[#e6c78e] transition-colors share-send-btn" data-user="${escapeHtml(t.username)}">Send</button>
    </div>
  `).join('');

  bindShareSendButtons();
}

function bindShareSendButtons() {
  document.querySelectorAll('.share-send-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetUser = btn.getAttribute('data-user');
      const sent = await sendDirectMessage(
        targetUser,
        `Shared a spot with you: ${buildShareUrl(activeSharePostId)}`,
        activeSharePostId
      );
      if (!sent) return;
      btn.textContent = 'Sent';
      btn.classList.add('!bg-emerald-500', '!text-black');
      showToast(`Spot shared with ${targetUser}`);

      // The share sheet closes itself once the spot is delivered.
      setTimeout(() => {
        const modal = document.getElementById('sharePostModal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
      }, 700);
    });
  });
}

// ============================================================
// 16. Comments modal
// ============================================================
function initCommentsModal() {
  const modal = document.getElementById('commentsModal');
  const closeBtn = document.getElementById('closeCommentsModalBtn');
  const form = document.getElementById('commentsModalForm');
  const input = document.getElementById('commentsModalInput');

  if (closeBtn) closeBtn.onclick = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };

  document.querySelectorAll('.comments-modal-symbol').forEach(b => {
    b.addEventListener('click', () => {
      input.value += b.getAttribute('data-symbol');
      input.focus();
    });
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !activeCommentModalPostId) return;
      if (!requireAuth('comment on spots')) return;

      try {
        const saved = await api(`/posts/${activeCommentModalPostId}/comment`, {
          method: 'POST',
          body: JSON.stringify({
            username: currentUser.username,
            user_id: currentUser.id,
            avatar: currentUser.avatar,
            text
          })
        });

        const post = allPosts.find(item => String(item.id) === String(activeCommentModalPostId));
        if (post) {
          if (!post.comments) post.comments = [];
          post.comments.push(saved);
        }

        renderCommentsModalContent(post);

        const cardList = document.getElementById(`comment-list-${activeCommentModalPostId}`);
        if (cardList) {
          cardList.insertAdjacentHTML('beforeend', `
            <div class="comment-row">
              <strong class="cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(saved.username)}')">${escapeHtml(saved.username)}</strong>
              <span>${escapeHtml(saved.text)}</span>
            </div>
          `);
        }
        const viewAllBtn = document.querySelector(`#post-${activeCommentModalPostId} .view-all-comments-btn`);
        if (viewAllBtn && post) viewAllBtn.textContent = `View all ${post.comments.length} comments`;

        input.value = '';
        showToast('Comment posted');
        loadNotifications();
      } catch (err) {
        showToast('Could not post the comment. Please try again.');
      }
    });
  }
}

function openFullCommentsModal(postId) {
  activeCommentModalPostId = postId;
  const post = allPosts.find(p => String(p.id) === String(postId));
  if (!post) return;

  const modal = document.getElementById('commentsModal');
  const imgEl = document.getElementById('commentsModalMediaImg');
  const avatarEl = document.getElementById('commentsModalAuthorAvatar');
  const userEl = document.getElementById('commentsModalAuthorUsername');
  const locEl = document.getElementById('commentsModalLocation');

  imgEl.src = getMediaList(post)[0] || '';
  avatarEl.src = post.author_avatar || avatarFor(post.username);
  userEl.textContent = post.username;
  locEl.textContent = `${String.fromCodePoint(0x2316)} ${cleanLocationDisplay(post.location)}`;

  renderCommentsModalContent(post);

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function renderCommentsModalContent(post) {
  const listEl = document.getElementById('commentsModalList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (post.description) {
    const captionRow = document.createElement('div');
    captionRow.className = 'comments-modal-row pb-3 border-b border-white/5';
    captionRow.innerHTML = `
      <img src="${escapeHtml(post.author_avatar || avatarFor(post.username))}" class="comments-modal-avatar cursor-pointer" onclick="window.openUserProfile('${escapeHtml(post.username)}')">
      <div class="flex-1">
        <strong class="text-white mr-1 cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(post.username)}')">${escapeHtml(post.username)}</strong>
        <span class="text-white/80 leading-relaxed">${formatCaption(escapeHtml(post.description))}</span>
        <div class="text-[10px] text-white/40 mt-1">${getRelativeTime(post.created_at)}</div>
      </div>
    `;
    listEl.appendChild(captionRow);
  }

  const comments = post.comments || [];
  if (comments.length === 0) {
    listEl.innerHTML += '<div class="text-center py-8 text-white/50 text-xs">No comments yet. Start the conversation.</div>';
    return;
  }

  comments.forEach(c => {
    const row = document.createElement('div');
    row.className = 'comments-modal-row';
    const cAvatar = c.avatar || avatarFor(c.username);
    const isMine = c.username === currentUser.username;
    row.innerHTML = `
      <img src="${escapeHtml(cAvatar)}" class="comments-modal-avatar cursor-pointer" onclick="window.openUserProfile('${escapeHtml(c.username)}')">
      <div class="flex-1">
        <strong class="text-white mr-1 cursor-pointer hover:underline" onclick="window.openUserProfile('${escapeHtml(c.username)}')">${escapeHtml(c.username)}</strong>
        <span class="text-white/80 leading-relaxed">${escapeHtml(c.text)}</span>
        <div class="flex items-center gap-3 text-[10px] text-white/40 mt-1">
          <span>${getRelativeTime(c.created_at)}</span>
          <span class="cursor-pointer hover:text-white" data-reply="${escapeHtml(c.username)}">Reply</span>
          ${c.likes ? `<span class="text-emerald-400 font-semibold">&hearts; ${c.likes}</span>` : ''}
          ${isMine ? `<span class="cursor-pointer hover:text-red-300" data-delete-comment="${c.id}">Delete</span>` : ''}
        </div>
      </div>
      <button class="comments-modal-like-btn ${c.isLiked ? 'liked' : ''}" data-comment-like="${c.id}">${c.isLiked ? '♥' : '♡'}</button>
    `;
    listEl.appendChild(row);
  });

  listEl.querySelectorAll('[data-reply]').forEach(el => {
    el.addEventListener('click', () => {
      const input = document.getElementById('commentsModalInput');
      if (input) {
        input.value = `@${el.getAttribute('data-reply')} `;
        input.focus();
      }
    });
  });

  listEl.querySelectorAll('[data-comment-like]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!requireAuth('like comments')) return;
      const commentId = btn.getAttribute('data-comment-like');
      const wasLiked = btn.classList.contains('liked');
      btn.classList.toggle('liked', !wasLiked);
      btn.textContent = wasLiked ? '♥' : '♡';
      try {
        const res = await api(`/comments/${commentId}/like`, {
          method: 'POST',
          body: JSON.stringify({ user_id: currentUser.id })
        });
        const comment = (post.comments || []).find(c => String(c.id) === String(commentId));
        if (comment) comment.likes = res.likes;
      } catch (err) {
        btn.classList.toggle('liked', wasLiked);
        btn.textContent = wasLiked ? '♥' : '♡';
      }
    });
  });

  listEl.querySelectorAll('[data-delete-comment]').forEach(el => {
    el.addEventListener('click', async () => {
      const commentId = el.getAttribute('data-delete-comment');
      if (!confirm('Delete this comment?')) return;
      try {
        await api(`/comments/${commentId}`, {
          method: 'DELETE',
          body: JSON.stringify({ user_id: currentUser.id, username: currentUser.username })
        });
        post.comments = (post.comments || []).filter(c => String(c.id) !== String(commentId));
        renderCommentsModalContent(post);
        showToast('Comment deleted');
      } catch (err) {
        showToast('Could not delete the comment.');
      }
    });
  });
}

// ============================================================
// 17. Edit profile
// ============================================================
function initEditProfileModal() {
  const modal = document.getElementById('editProfileModal');
  const closeBtn = document.getElementById('closeEditProfileBtn');
  const saveBtn = document.getElementById('saveProfileBtn');
  const nameInput = document.getElementById('editNameInput');
  const bioInput = document.getElementById('editBioInput');
  const avatarFileInput = document.getElementById('editAvatarFileInput');
  const avatarPreview = document.getElementById('editAvatarPreview');
  const avatarHelp = document.getElementById('editAvatarHelp');
  if (avatarFileInput) avatarFileInput.onchange = async () => {
    const file = avatarFileInput.files && avatarFileInput.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      avatarFileInput.value = '';
      avatarHelp.textContent = 'Choose a JPG, PNG or WebP image.';
      avatarHelp.classList.add('text-red-300');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      avatarFileInput.value = '';
      avatarHelp.textContent = 'Choose an image smaller than 5 MB.';
      avatarHelp.classList.add('text-red-300');
      return;
    }

    avatarHelp.classList.remove('text-red-300');
    avatarHelp.textContent = 'Preparing photo…';
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      pendingProfileAvatar = canvas.toDataURL('image/jpeg', 0.82);
      avatarPreview.src = pendingProfileAvatar;
      avatarHelp.textContent = `${file.name} ready to upload`;
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      avatarFileInput.value = '';
      avatarHelp.textContent = 'This image could not be opened. Choose another photo.';
      avatarHelp.classList.add('text-red-300');
    };
    image.src = objectUrl;
  };

  if (closeBtn) closeBtn.onclick = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };

  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (!requireAuth('edit your profile')) return;

      const payload = {
        user_id: currentUser.id,
        username: currentUser.username,
        name: nameInput.value.trim(),
        bio: bioInput.value.trim(),
        avatar: pendingProfileAvatar
      };

      saveBtn.textContent = 'Saving...';
      try {
        const updated = await api('/users/profile', { method: 'POST', body: JSON.stringify(payload) });
        currentUser = { ...currentUser, ...updated };
        sessionStorage.setItem('currentUser', JSON.stringify({ id: currentUser.id, username: currentUser.username }));
        initUserProfile();
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        showToast('Profile updated');
        loadPosts();
      } catch (err) {
        showToast('Could not save your profile. Please try again.');
      } finally {
        saveBtn.textContent = 'Save Changes';
      }
    };
  }
}

function openEditProfileModal() {
  const modal = document.getElementById('editProfileModal');
  const nameInput = document.getElementById('editNameInput');
  const bioInput = document.getElementById('editBioInput');
  const avatarPreview = document.getElementById('editAvatarPreview');
  const avatarFileInput = document.getElementById('editAvatarFileInput');
  const avatarHelp = document.getElementById('editAvatarHelp');

  if (nameInput) nameInput.value = currentUser.name || '';
  if (bioInput) bioInput.value = currentUser.bio || '';
  pendingProfileAvatar = currentUser.avatar || '';
  if (avatarPreview) avatarPreview.src = currentUser.avatar || avatarFor(currentUser.username);
  if (avatarFileInput) avatarFileInput.value = '';
  if (avatarHelp) {
    avatarHelp.textContent = 'Select a JPG, PNG or WebP image. It will be resized for your profile.';
    avatarHelp.classList.remove('text-red-300');
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

// ============================================================
// 18. Suggestions
// ============================================================
async function loadSuggestions(limit = 5) {
  const container = document.getElementById('suggestionsContainer');
  if (!container) return;

  let suggestions = [];
  try {
    suggestions = await api(`/users/suggestions?user_id=${currentUser.id}&limit=${limit}`) || [];
  } catch (err) {
    console.warn('Suggestions fetch failed:', err);
    suggestions = [];
  }

  container.innerHTML = suggestions.length === 0
    ? '<p class="text-xs text-white/50 text-center py-5">No other travelers to suggest yet.</p>'
    : suggestions.map(u => `
      <div class="suggestion-row">
        <div class="suggested-user-info cursor-pointer" onclick="window.openUserProfile('${escapeHtml(u.username)}')">
          <img src="${escapeHtml(u.avatar)}" class="suggested-avatar" alt="${escapeHtml(u.username)}">
          <div>
            <div class="flex items-center gap-1">
              <span class="text-xs font-bold text-white block">${escapeHtml(u.username)}</span>
              ${u.is_verified_pro ? '<span class="text-[10px] text-[#d2a35c]">&#x2713;</span>' : ''}
            </div>
            <span class="text-[10px] text-white/50">${escapeHtml(u.bio || u.name || 'Traveler')}</span>
          </div>
        </div>
        <button class="follow-pill-btn ${u.isFollowing ? 'following' : ''}" data-userid="${u.id}" data-username="${encodeURIComponent(u.username)}">
          ${u.isFollowing ? 'Following' : 'Follow'}
        </button>
      </div>
    `).join('');

  container.querySelectorAll('.follow-pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFollowToggle(btn.getAttribute('data-userid'),
        decodeURIComponent(btn.getAttribute('data-username')), btn);
    });
  });
}

// ============================================================
// 19. SOS
// ============================================================
function initSosDistress() {
  const sosButtons = ['quickSosBtn', 'mobileSosBtn']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  const modal = document.getElementById('sosConfirmModal');
  const cancelBtn = document.getElementById('sosCancelBtn');
  const sendBtn = document.getElementById('sosSendBtn');
  const locationCheckbox = document.getElementById('sosShareLocation');
  const status = document.getElementById('sosModalStatus');
  if (!sosButtons.length || !modal || !sendBtn) return;
  let sending = false;

  const closeModal = () => {
    if (sending) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    status?.classList.add('hidden');
  };
  const openModal = () => {
    if (!requireAuth('send an emergency SOS alert') || sending) return;
    status?.classList.add('hidden');
    if (locationCheckbox) locationCheckbox.checked = false;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  };
  const sendSos = async () => {
    if (!requireAuth('send an emergency SOS alert') || sending) return;
    const requestedLocation = !!locationCheckbox?.checked;
    sending = true;
    sosButtons.forEach(button => { button.disabled = true; });
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending...';
    if (status) {
      status.textContent = locationCheckbox?.checked ? 'Checking location permission...' : 'Recording your alert...';
      status.classList.remove('hidden');
    }
    let coordinates = null;
    let locationLabel = 'Unknown Location';
    if (locationCheckbox?.checked && navigator.geolocation) {
      coordinates = await new Promise(resolve => {
        const timeout = window.setTimeout(() => resolve(null), 7000);
        navigator.geolocation.getCurrentPosition(
          pos => {
            window.clearTimeout(timeout);
            resolve({
              lat: Number(pos.coords.latitude.toFixed(5)),
              lng: Number(pos.coords.longitude.toFixed(5)),
              accuracy: Math.round(pos.coords.accuracy)
            });
          },
          () => { window.clearTimeout(timeout); resolve(null); },
          { enableHighAccuracy: true, timeout: 6500, maximumAge: 30000 }
        );
      });
    }
    if (coordinates) locationLabel = `${coordinates.lat}, ${coordinates.lng}`;

    try {
      const res = await api('/sos/trigger', {
        method: 'POST',
        body: JSON.stringify({
          username: currentUser.username,
          location: locationLabel,
          coordinates,
          dangerScore: 92
        })
      });
      if (!res || res.status !== 'success') throw new Error('SOS endpoint rejected the alert');
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      showToast(coordinates
        ? 'SOS alert recorded with your current location.'
        : requestedLocation
          ? 'SOS alert recorded. Location was unavailable.'
          : 'SOS alert recorded.');
    } catch (e) {
      console.warn('SOS alert could not be sent:', e);
      if (status) {
        status.textContent = e.message || 'Could not record the SOS alert. Check your connection and retry.';
        status.classList.remove('hidden');
      }
    } finally {
      sending = false;
      sosButtons.forEach(button => { button.disabled = false; });
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send alert';
    }
  };

  sosButtons.forEach(button => button.addEventListener('click', openModal));
  cancelBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  sendBtn.addEventListener('click', sendSos);
}

// ============================================================
// 20. Deep links
// ============================================================
function handleDeepLink() {
  const hash = window.location.hash || '';
  const match = hash.match(/^#post-(.+)$/);
  if (!match) return;
  const postId = match[1];
  setTimeout(() => jumpToPost(postId), 600);
}

// ============================================================
// Helpers
// ============================================================
function avatarFor(seed) {
  const words = String(seed || 'traveler').trim().replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || 'T').slice(0, 2)).replace(/[^a-z0-9]/gi, '').toUpperCase() || 'T';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#2a3027"/><text x="48" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" fill="#d2a35c">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function cleanLocationDisplay(loc) {
  if (!loc) return 'Secret Spot';
  if (loc.startsWith('http://') || loc.startsWith('https://')) return 'Pinned Map Location';
  return loc.replace(/^⌖\s*/, '');
}
function formatCaption(str) {
  return str.replace(/(#[\w]+)/g, '<span class="text-[#d2a35c] font-semibold hover:underline cursor-pointer" onclick="window.searchLocation(\'$1\')">$1</span>');
}

function getRelativeTime(isoStr) {
  if (!isoStr) return 'now';
  const time = new Date(isoStr).getTime();
  if (isNaN(time)) return 'now';
  const diffSec = Math.floor((Date.now() - time) / 1000);
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return `${Math.floor(diffSec / 604800)}w`;
}

function showToast(message) {
  const existing = document.getElementById('appToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'appToast';
  toast.className = 'fixed right-6 z-[1300] bg-[#0c1613] border border-[#d2a35c]/60 text-white text-xs font-bold px-4 py-3 rounded-2xl shadow-2xl flex items-center gap-2 backdrop-blur-xl animate-bounce';
  toast.style.bottom = 'calc(68px + env(safe-area-inset-bottom) + 12px)';
  toast.innerHTML = `<span>✦</span><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}
