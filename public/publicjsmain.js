// UniTalk — main.js v3.1

// Auto-hide alerts after 5 seconds
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.alert').forEach(function(el) {
    setTimeout(function() {
      el.style.transition = 'opacity 0.5s';
      el.style.opacity = '0';
      setTimeout(function() { el.remove(); }, 500);
    }, 5000);
  });
});

// Load faculties dropdown
async function loadFaculties(universityId, facultySelectId, selectedFacultyId) {
  const sel = document.getElementById(facultySelectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">Загрузка...</option>';
  if (!universityId) { sel.innerHTML = '<option value="">Сначала выберите вуз</option>'; return; }
  try {
    const r  = await fetch('/api/faculties/' + universityId);
    const fs = await r.json();
    sel.innerHTML = '<option value="">Выберите факультет</option>';
    fs.forEach(function(f) {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = f.name;
      if (selectedFacultyId && f.id === selectedFacultyId) o.selected = true;
      sel.appendChild(o);
    });
  } catch(e) { sel.innerHTML = '<option value="">Ошибка загрузки</option>'; }
}

// ── Notification badges ───────────────────────────────────────────────────────
(function() {
  const badgeChats = document.getElementById('badge-chats');
  const badgeNews  = document.getElementById('badge-news');
  const navNews    = document.getElementById('nav-news');
  const navChats   = document.getElementById('nav-chats');

  if (!badgeChats && !badgeNews) return; // not logged in

  const LS_NEWS_KEY  = 'unitalk_news_seen_at';
  const LS_NEWS_CNT  = 'unitalk_news_count_hidden';

  // When user clicks News tab — clear news badge and save timestamp
  if (navNews) {
    navNews.addEventListener('click', function() {
      badgeNews.style.display = 'none';
      localStorage.setItem(LS_NEWS_KEY, Date.now());
      localStorage.removeItem(LS_NEWS_CNT);
    });
  }
  // When user clicks Chats tab — clear chat badge
  if (navChats) {
    navChats.addEventListener('click', function() {
      badgeChats.style.display = 'none';
    });
  }

  function setbadge(el, count) {
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : count;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }

  async function fetchBadges() {
    try {
      const data = await fetch('/api/notifications').then(function(r) {
        if (!r.ok) return null;
        return r.json();
      });
      if (!data) return;

      // Chat unread
      if (badgeChats && !window.location.pathname.startsWith('/chats')) {
        setbadge(badgeChats, data.messages);
      }

      // News badge: show if there are new articles since last visit
      if (badgeNews && !window.location.pathname.startsWith('/news')) {
        const seenAt = parseInt(localStorage.getItem(LS_NEWS_KEY) || '0');
        // If user never visited news or last visit was more than a small window, show the count
        // We use server-returned count as a proxy for "new since last week"
        const hidden = localStorage.getItem(LS_NEWS_CNT);
        if (hidden === null || parseInt(hidden) !== data.news) {
          // Only show badge if user hasn't dismissed it for this count
          if (!seenAt || (Date.now() - seenAt) > 5 * 60 * 1000) {
            setBadge:
            if (data.news > 0) {
              badgeNews.textContent = data.news;
              badgeNews.style.display = '';
            }
          }
        }
      }
    } catch(e) { /* silently fail */ }
  }

  // Poll every 30 seconds
  fetchBadges();
  setInterval(fetchBadges, 30000);
})();
