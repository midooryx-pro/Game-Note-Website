/*
  GAME NOTE
  RAWG-powered game discovery and personal library.

  - Library key preserved: gameNoteSavedGames (your saved games carry over)
  - Discover mix: one feed blending your taste, popular now, acclaimed and hidden gems
  - Discover hides low-quality entries (no cover, symbol names, almost no players)
  - Grid / list view (list view is numbered), remembered separately for each page
  - Game details end with "Games you might also like"
  - Sort options change per page; filters ask RAWG on Discover and
    filter your own list on Your Plan / Completed
  - Notes + star rating per saved game, undo, backup, keyboard shortcuts
  - RAWG requests go through /api/rawg on this site, so the secret key stays on the server
*/

"use strict";

const API_BASE = `${window.location.origin}/api/rawg`;
const STORAGE_KEY = "gameNoteSavedGames";
const THEME_KEY = "gameNoteTheme";
const VIEWS_KEY = "gameNoteViews";
const PAGE_SIZE = 24;
const PICKS_PER_SOURCE = 12; // games taken from each source of the Discover mix
const SIMILAR_SIZE = 8; // games in "you might also like"
const MAX_SEARCH_PAGES = 100;
const MAX_BROWSE_PAGES = 12; // deeper pages are mostly low-quality entries

// Sort options for each page. [value, label]
const SORT_OPTIONS = {
  discover: [
    ["picked", "Picked for you"],
    ["popular", "Most popular"],
    ["new", "New & popular"],
    ["metascore", "Highest Metascore"]
  ],
  plan: [
    ["priority", "Priority ★ first"],
    ["recent", "Recently added"],
    ["metascore", "Highest Metascore"],
    ["newest", "Newest release"],
    ["oldest", "Oldest release"],
    ["az", "Name A–Z"]
  ],
  completed: [
    ["recent", "Recently added"],
    ["rating", "Your rating"],
    ["priority", "Priority ★ first"],
    ["metascore", "Highest Metascore"],
    ["newest", "Newest release"],
    ["oldest", "Oldest release"],
    ["az", "Name A–Z"]
  ]
};

const DEFAULT_SORT = {
  discover: "picked",
  plan: "priority",
  completed: "recent"
};

// RAWG "parent platform" ids: each one covers every generation.
const PLATFORM_OPTIONS = [
  { value: "1", label: "PC" },
  { value: "2", label: "PlayStation" },
  { value: "3", label: "Xbox" },
  { value: "7", label: "Nintendo" }
];

const pageTitles = {
  discover: "Discover",
  plan: "Your Plan",
  completed: "Completed"
};

const $ = (selector) => document.querySelector(selector);

const nav = $(".main-nav");
const navButtons = document.querySelectorAll(".nav-button");
const navIndicator = $("#nav-indicator");
const gridTitle = $("#grid-title");
const feedEyebrow = $("#feed-eyebrow");
const feedDescription = $("#feed-description");
const gamesGrid = $("#games-grid");
const searchBar = $("#search-bar");
const addButton = $("#add-btn");
const newMixButton = $("#new-mix-btn");
const themeButton = $("#theme-btn");
const genreFilter = $("#genre-filter");
const platformFilter = $("#platform-filter");
const metascoreFilter = $("#metascore-filter");
const yearFilter = $("#year-filter");
const sortSelect = $("#sort");
const resetFiltersButton = $("#reset-filters-btn");
const pagination = $("#pagination");
const previousPageButton = $("#previous-page");
const nextPageButton = $("#next-page");
const pageIndicator = $("#page-indicator");
const resultsCount = $("#results-count");
const viewToggle = $("#view-toggle");
const viewButtons = document.querySelectorAll(".view-button");
const exportButton = $("#export-btn");
const importButton = $("#import-btn");
const importInput = $("#import-input");
const clearButton = $("#clear-btn");

let currentPage = "discover";
let currentView = "grid"; // "grid" or "details"
let currentApiPage = 1;
let lastApiPage = 1;
let searchTimer;
let requestNumber = 0;
let mixSeed = Math.floor(Math.random() * 2 ** 32);
let currentDetailsId = null;
let currentDiscoverGames = [];
let currentDiscoverMode = "mix"; // "mix" or "browse"
let currentSimilarGames = [];
let gridScroll = 0;

// Card layout ("grid" or "list"), remembered separately for each page.
const viewModes = {
  discover: "grid",
  plan: "grid",
  completed: "grid"
};

const detailCache = new Map();
const screenshotCache = new Map();
const discoveryCache = new Map();
const similarCache = new Map(); // game id -> finished list of similar games
const similarPending = new Map(); // game id -> request still running

/* -------------------- SAFE HELPERS -------------------- */

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function cleanDescription(html = "") {
  return new DOMParser()
    .parseFromString(html, "text/html")
    .body.textContent
    .trim();
}

function uniqueById(games) {
  const seen = new Set();

  return games.filter(game => {
    if (!game || game.id == null || seen.has(String(game.id))) {
      return false;
    }

    seen.add(String(game.id));
    return true;
  });
}

// Takes one item from each list in turn, so no source ends up in a block.
function interleave(lists) {
  const result = [];
  const longest = Math.max(0, ...lists.map(list => list.length));

  for (let i = 0; i < longest; i++) {
    lists.forEach(list => {
      if (i < list.length) result.push(list[i]);
    });
  }

  return result;
}

function toSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Stable 0–1 number per game for the current mix, so "New mix" reshuffles
// the order without the feed changing while you browse.
function jitter(game) {
  return ((((Number(game.id) || 0) * 2654435761) + mixSeed) >>> 0) % 1000 / 1000;
}

function getGameGenres(game) {
  return (game.genres || [])
    .map(item => typeof item === "string" ? item : item?.name)
    .filter(Boolean);
}

function getGamePlatforms(game) {
  return (game.platforms || [])
    .map(item => item?.platform?.name || item?.name || item)
    .filter(item => typeof item === "string" && item);
}

function getReleaseYear(game) {
  const date = game.released || "";
  return /^\d{4}/.test(date) ? date.slice(0, 4) : "";
}

function getMetascore(game) {
  const score = Number(game.metacritic);
  return Number.isFinite(score) && score > 0 ? score : null;
}

function formatReleaseDate(game) {
  if (!game.released) return "Release date unknown";

  const date = new Date(`${game.released}T00:00:00`);

  if (Number.isNaN(date.getTime())) return game.released;

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function countLabel(count) {
  return `${count.toLocaleString()} ${count === 1 ? "game" : "games"}`;
}

function dateString(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

// Loads a smaller version of RAWG artwork for cards (falls back to the original).
function cardImage(url) {
  return typeof url === "string" && url.startsWith("https://media.rawg.io/media/games/")
    ? url.replace("/media/games/", "/media/resize/640/-/games/")
    : url;
}

// Hides junk entries on Discover: no cover, symbol-only names, or almost no players.
function isQualityGame(game) {
  if (!game || !game.background_image) return false;
  if (!/[\p{L}\p{N}]{2,}/u.test(game.name || "")) return false;

  const added = Number(game.added || 0);
  const ratingsCount = Number(game.ratings_count || 0);

  return getMetascore(game) !== null || added >= 200 || ratingsCount >= 20;
}

// Keeps only what we need, so saved games stay small in localStorage.
function slimGame(game, extra = {}) {
  return {
    id: game.id,
    name: game.name || "Unknown game",
    slug: game.slug || "",
    background_image: game.background_image || "",
    released: game.released || "",
    metacritic: game.metacritic || null,
    genres: (game.genres || []).map(item =>
      typeof item === "string"
        ? { name: item }
        : { id: item.id, name: item.name, slug: item.slug }
    ),
    platforms: (game.platforms || []).map(item =>
      item?.platform
        ? {
            platform: {
              id: item.platform.id,
              name: item.platform.name,
              slug: item.platform.slug
            }
          }
        : item
    ),
    // Parent platforms (PC, PlayStation, Xbox, Nintendo...) power the platform filter.
    parents: game.parents ||
      (game.parent_platforms || [])
        .map(item => item?.platform?.id)
        .filter(Boolean),
    parentsLoaded: Boolean(game.parentsLoaded || game.parent_platforms?.length),
    ...extra
  };
}

/* -------------------- API -------------------- */

// Asks our own server (api/rawg.js) for RAWG data.
// The server adds the secret key, so no key is needed here.
// Example address: /api/rawg?path=games/3498
async function fetchRAWG(endpoint, params = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set("path", endpoint);

  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, value);
    }
  });

  let response;

  try {
    response = await fetch(url);
  } catch {
    throw new Error("Couldn't reach the server. Check your internet connection and try again.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("RAWG rejected the request. Check the RAWG_API_KEY in your Vercel settings.");
  }

  if (response.status === 429) {
    throw new Error("RAWG's request limit was reached. Please try again later.");
  }

  if (!response.ok) {
    throw new Error(`RAWG request failed (${response.status}).`);
  }

  return response.json();
}

// Fetches a list of games (popular first). A failed request gives an empty list,
// so one broken request never empties the whole feed. Results are cached in memory.
function fetchGameList(params) {
  const key = JSON.stringify(params);

  if (!discoveryCache.has(key)) {
    discoveryCache.set(
      key,
      fetchRAWG("games", {
        ordering: "-added",
        exclude_additions: true,
        ...params
      })
        .then(data => Array.isArray(data.results) ? data.results : [])
        .catch(() => {
          discoveryCache.delete(key);
          return [];
        })
    );

    // Keep the in-memory cache bounded.
    if (discoveryCache.size > 40) {
      discoveryCache.delete(discoveryCache.keys().next().value);
    }
  }

  return discoveryCache.get(key);
}

/* -------------------- SAVED LIBRARY -------------------- */

function getSavedGames() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveGames(games) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  } catch {
    showNotice("Couldn't save. Your browser storage may be full or blocked.");
  }

  updateLibraryStats();
}

function findSavedGame(id) {
  return getSavedGames().find(game => String(game.id) === String(id));
}

function getSavedIds() {
  return new Set(getSavedGames().map(game => String(game.id)));
}

// Finds a saved game, lets `update` change it, saves, and returns it (or null).
function updateSavedGame(id, update) {
  const saved = getSavedGames();
  const game = saved.find(item => String(item.id) === String(id));

  if (!game) return null;

  update(game);
  saveGames(saved);

  return game;
}

// Finds full game info from whatever we already have, or asks RAWG.
async function resolveGame(id) {
  const match = game => String(game.id) === String(id);

  return (
    findSavedGame(id) ||
    currentDiscoverGames.find(match) ||
    currentSimilarGames.find(match) ||
    await getCachedDetails(id)
  );
}

function addGame(game, destination = "plan", priority = false) {
  if (!game || game.id == null) return;

  const saved = getSavedGames();
  const existing = saved.find(item => String(item.id) === String(game.id));
  const label = destination === "completed" ? "Completed" : "Your Plan";

  if (existing) {
    const moved = existing.status !== destination;

    existing.status = destination;
    if (priority) existing.priority = true;

    saveGames(saved);
    showNotice(
      moved
        ? `${existing.name} moved to ${label}.`
        : `${existing.name} is already in ${label}.`
    );
  } else {
    saved.push(slimGame(game, {
      status: destination,
      priority: Boolean(priority || game.priority),
      addedAt: Date.now(),
      note: "",
      rating: 0
    }));

    saveGames(saved);
    showNotice(`${game.name || "Game"} added to ${label}.`, {
      label: "Undo",
      onClick: () => removeSavedGame(game.id, { undoOfAdd: true })
    });
  }

  refreshCurrentView();
}

async function togglePriority(id) {
  if (!findSavedGame(id)) {
    try {
      addGame(await resolveGame(id), "plan", true);
    } catch {
      showNotice("Couldn't load this game to mark it as a priority. Please try again.");
    }

    return;
  }

  const game = updateSavedGame(id, item => {
    item.priority = !item.priority;
  });

  showNotice(
    game.priority
      ? `${game.name} marked as a priority.`
      : `${game.name} priority removed.`
  );

  refreshCurrentView();
}

function changeGameStatus(id, status) {
  const game = updateSavedGame(id, item => {
    item.status = status;
  });

  if (!game) return;

  showNotice(
    status === "completed"
      ? `${game.name} marked as completed.`
      : `${game.name} moved to Your Plan.`
  );

  refreshCurrentView();
}

function removeSavedGame(id, { undoOfAdd = false } = {}) {
  const saved = getSavedGames();
  const index = saved.findIndex(item => String(item.id) === String(id));

  if (index === -1) return;

  const [game] = saved.splice(index, 1);
  saveGames(saved);

  if (undoOfAdd) {
    showNotice(`Adding ${game.name} was undone.`);
  } else {
    showNotice(`${game.name} removed from your library.`, {
      label: "Undo",
      onClick: () => restoreGame(game)
    });
  }

  refreshCurrentView();
}

function restoreGame(game) {
  const saved = getSavedGames();

  if (!saved.some(item => String(item.id) === String(game.id))) {
    saved.push(game);
    saveGames(saved);
  }

  showNotice(`${game.name} is back in your library.`);
  refreshCurrentView();
}

function setRating(id, value) {
  const game = updateSavedGame(id, item => {
    item.rating = item.rating === value ? 0 : value;
  });

  if (!game) return;

  // Update the stars in place so the notes box keeps its focus.
  document.querySelectorAll(".gn-rate").forEach(star => {
    const on = Number(star.dataset.value) <= game.rating;
    star.classList.toggle("is-on", on);
    star.setAttribute("aria-pressed", String(on));
  });
}

function saveNote(id, text) {
  if (!updateSavedGame(id, item => { item.note = text; })) return;

  const status = $("#note-status");
  if (status) status.textContent = "Saved ✓";
}

function updateLibraryStats() {
  const saved = getSavedGames();
  const planCount = saved.filter(game => game.status === "plan").length;
  const completedCount = saved.filter(game => game.status === "completed").length;
  const priorityCount = saved.filter(game => game.priority).length;

  $("#library-count").textContent = saved.length;
  $("#plan-count").textContent = planCount;
  $("#completed-count").textContent = completedCount;
  $("#priority-count").textContent = priorityCount;
  $("#plan-nav-count").textContent = planCount;
  $("#completed-nav-count").textContent = completedCount;
}

/* -------------------- BACKUP: EXPORT / IMPORT / CLEAR -------------------- */

function exportLibrary() {
  const games = getSavedGames();

  if (!games.length) {
    showNotice("Your library is empty, so there is nothing to export yet.");
    return;
  }

  const data = {
    app: "Game Note",
    version: 1,
    exportedAt: new Date().toISOString(),
    games
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `game-note-backup-${new Date().toISOString().slice(0, 10)}.json`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice(`Exported ${countLabel(games.length)}.`);
}

async function importLibrary(file) {
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed?.games;

    if (!Array.isArray(list)) {
      throw new Error("not a list");
    }

    const saved = getSavedGames();
    const known = new Set(saved.map(game => String(game.id)));
    let added = 0;

    list.forEach(game => {
      if (
        !game ||
        game.id == null ||
        !game.name ||
        !["plan", "completed"].includes(game.status) ||
        known.has(String(game.id))
      ) {
        return;
      }

      saved.push(slimGame(game, {
        status: game.status,
        priority: Boolean(game.priority),
        addedAt: Number(game.addedAt) || Date.now(),
        note: typeof game.note === "string" ? game.note.slice(0, 2000) : "",
        rating: Math.min(5, Math.max(0, Number(game.rating) || 0))
      }));

      known.add(String(game.id));
      added++;
    });

    saveGames(saved);
    showNotice(
      added
        ? `Imported ${countLabel(added)}.`
        : "Nothing new to import. Those games are already in your library."
    );
    refreshCurrentView();
  } catch {
    showNotice("That file doesn't look like a Game Note backup.");
  } finally {
    importInput.value = "";
  }
}

function clearLibrary() {
  const backup = getSavedGames();

  if (!backup.length) {
    showNotice("Your library is already empty.");
    return;
  }

  const sure = confirm(
    `Remove all ${countLabel(backup.length)} from your library?\n\nTip: use "Export backup" first if you want a copy.`
  );

  if (!sure) return;

  saveGames([]);
  showNotice("Library cleared.", {
    label: "Undo",
    onClick: () => {
      saveGames(backup);
      showNotice("Your library was restored.");
      refreshCurrentView();
    }
  });

  refreshCurrentView();
}

/* -------------------- NOTICES AND STATES -------------------- */

function showNotice(message, action) {
  const notice = $("#game-note-notice");
  if (!notice) return;

  notice.textContent = "";

  const text = document.createElement("span");
  text.textContent = message;
  notice.appendChild(text);

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gn-notice-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      notice.classList.remove("is-visible");
      action.onClick();
    });
    notice.appendChild(button);
  }

  notice.classList.add("is-visible");

  clearTimeout(showNotice.timer);

  showNotice.timer = setTimeout(() => {
    notice.classList.remove("is-visible");
  }, action ? 5500 : 2800);
}

function showSkeletons(count = 10) {
  syncGridLayout();

  gamesGrid.innerHTML = Array.from({ length: count }, () => `
    <div class="gn-skeleton" aria-hidden="true">
      <div class="gn-skeleton-cover"></div>
      <div class="gn-skeleton-line"></div>
      <div class="gn-skeleton-line short"></div>
    </div>
  `).join("");

  resultsCount.textContent = "Loading…";
}

function showMessage(title, message, retry = false) {
  gamesGrid.innerHTML = `
    <div class="gn-message">
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(message)}</p>
      ${
        retry
          ? `<button class="button button-primary" data-action="retry" type="button">Try again</button>`
          : ""
      }
    </div>
  `;

  resultsCount.textContent = "";
}

function scrollToFeed() {
  $("#main-content").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* -------------------- GRID / LIST VIEW -------------------- */

// Applies the current page's layout. The list layout only applies to the
// games lists, never to the details page, and the switch hides on details.
function syncGridLayout() {
  const mode = viewModes[currentPage];
  const isGrid = currentView === "grid";

  gamesGrid.classList.toggle("is-list", mode === "list" && isGrid);
  viewToggle.hidden = !isGrid;

  viewButtons.forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.view === mode));
  });
}

// Changes the layout of the page you're on; the other pages keep theirs.
function setViewMode(mode) {
  viewModes[currentPage] = mode === "list" ? "list" : "grid";
  syncGridLayout();

  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(viewModes));
  } catch {
    // The layout still switches if storage is unavailable.
  }
}

function initializeViewModes() {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEWS_KEY) || "{}");

    Object.keys(viewModes).forEach(page => {
      if (stored?.[page] === "list") viewModes[page] = "list";
    });
  } catch {
    // Every page starts as a grid.
  }

  syncGridLayout();
}

/* -------------------- PERSONALIZATION -------------------- */

// What the library says about your taste: genres weighted by how much you care.
function getTasteProfile() {
  const genres = new Map();
  let total = 0;

  getSavedGames().forEach(game => {
    let weight = game.status === "plan" ? 1.35 : 1;

    if (game.priority) weight += 0.5;

    if (game.rating >= 4) {
      weight += 0.75;
    } else if (game.rating > 0 && game.rating <= 2) {
      weight *= 0.3;
    }

    total += weight;

    getGameGenres(game).forEach(name => {
      genres.set(name, (genres.get(name) || 0) + weight);
    });
  });

  const topGenres = [...genres.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  return { genres, total, topGenres };
}

function popularityScore(game) {
  const added = Math.max(0, Number(game.added || 0));
  const ratingsCount = Math.max(0, Number(game.ratings_count || 0));

  // Popularity metadata only; this deliberately doesn't use RAWG's user rating.
  return Math.log10(added + 1) * 12 +
    Math.log10(ratingsCount + 1) * 5;
}

// 0–40: how well a game's genres match what the library says you like.
function tasteScore(game, profile) {
  if (!profile.total) return 0;

  let matched = 0;

  getGameGenres(game).forEach(name => {
    matched += profile.genres.get(name) || 0;
  });

  return Math.min(matched / profile.total, 2) * 20;
}

/* -------------------- DISCOVER FEED -------------------- */

// The default Discover page: several sources blended into one feed.
async function buildMixFeed() {
  const profile = getTasteProfile();
  const savedIds = getSavedIds();
  const hasTaste = profile.topGenres.length > 0;
  const used = new Set(); // a game is only picked once
  const seed = mixSeed;

  const isUsable = game =>
    !savedIds.has(String(game.id)) &&
    !used.has(String(game.id)) &&
    isQualityGame(game);

  // Scores the usable games, keeps the best few, and marks them as used.
  const pick = (games, scoreOf) => {
    const chosen = uniqueById(games)
      .filter(isUsable)
      .map(game => ({ game, score: scoreOf(game) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, PICKS_PER_SOURCE)
      .map(item => item.game);

    chosen.forEach(game => used.add(String(game.id)));
    return chosen;
  };

  const topSlugs = profile.topGenres.map(toSlug);
  const personalRequests = [];

  if (topSlugs.length > 1) {
    personalRequests.push(fetchGameList({
      genres: topSlugs.join(","),
      page_size: 30,
      page: 1 + (seed % 2)
    }));
  }

  topSlugs.forEach((slug, index) => {
    personalRequests.push(fetchGameList({
      genres: slug,
      page_size: 30,
      page: 1 + ((seed >>> (4 + index)) % 2)
    }));
  });

  const [personal, now, classics, acclaimed, gems] = await Promise.all([
    Promise.all(personalRequests).then(lists => lists.flat()),
    fetchGameList({
      dates: `${dateString(365)},${dateString(0)}`,
      page_size: 40,
      page: 1 + (seed % 2)
    }),
    hasTaste ? [] : fetchGameList({ page_size: 40, page: 1 + ((seed >>> 2) % 3) }),
    fetchGameList({ metacritic: "85,100", page_size: 40, page: 1 + ((seed >>> 3) % 3) }),
    fetchGameList({ metacritic: "75,100", page_size: 40, page: 3 + ((seed >>> 6) % 4) })
  ]);

  // Picked in this order so your taste gets first choice of any shared game.
  const forYou = hasTaste
    ? pick(personal, game =>
        tasteScore(game, profile) +
        popularityScore(game) * 0.8 +
        jitter(game) * 8
      )
    : [];

  const popularNow = pick(now, game =>
    popularityScore(game) + jitter(game) * 10
  );

  const allTime = hasTaste
    ? []
    : pick(classics, game => popularityScore(game) + jitter(game) * 10);

  const critics = pick(acclaimed, game =>
    (getMetascore(game) || 85) * 1.2 +
    popularityScore(game) * 0.6 +
    jitter(game) * 10
  );

  const hidden = pick(gems, game =>
    (getMetascore(game) || 75) * 0.8 +
    popularityScore(game) * 0.25 +
    jitter(game) * 14
  );

  const games = interleave([forYou, popularNow, allTime, critics, hidden]);

  if (!games.length) {
    throw new Error("Couldn't load any games right now. Please try again.");
  }

  return { games };
}

// Search / filters / sorting: RAWG does the work, so results are real and paged.
async function buildBrowseFeed(filters, page) {
  const params = {
    page,
    page_size: PAGE_SIZE,
    exclude_additions: true,
    search: filters.query || undefined,
    genres: filters.genre || undefined,
    parent_platforms: filters.platform || undefined,
    ordering: filters.sort === "metascore" ? "-metacritic" : "-added"
  };

  if (filters.year) {
    params.dates = `${filters.year}-01-01,${filters.year}-12-31`;
  } else if (filters.sort === "new") {
    // "New & popular": the most popular games of the last 12 months.
    params.dates = `${dateString(365)},${dateString(0)}`;
  }

  if (filters.minScore) {
    params.metacritic = `${filters.minScore},100`;
  } else if (filters.sort === "metascore") {
    // Hide games without a score when sorting by score.
    params.metacritic = "1,100";
  }

  const data = await fetchRAWG("games", params);
  const total = Number(data.count) || 0;
  const maxPages = filters.query ? MAX_SEARCH_PAGES : MAX_BROWSE_PAGES;

  lastApiPage = Math.min(maxPages, Math.max(1, Math.ceil(total / PAGE_SIZE)));

  return { games: data.results || [] };
}

/* -------------------- SIMILAR GAMES -------------------- */

// Finds games like this one: same series, genres and themes (tags),
// then ranks them by how much they have in common.
async function buildSimilarGames(game) {
  const genreSlugs = (game.genres || [])
    .map(item => item.slug)
    .filter(Boolean)
    .slice(0, 2);

  // Skip tags that are too common ("Singleplayer") or too rare to find anything.
  const tagSlugs = (game.tags || [])
    .filter(tag => tag.language === "eng" && tag.games_count >= 600 && tag.games_count <= 60000)
    .sort((a, b) => a.games_count - b.games_count)
    .slice(0, 3)
    .map(tag => tag.slug);

  const requests = [
    fetchRAWG(`games/${encodeURIComponent(game.id)}/game-series`, { page_size: 8 })
      .then(data => data.results || [])
      .catch(() => [])
  ];

  if (genreSlugs.length && tagSlugs.length) {
    requests.push(fetchGameList({
      genres: genreSlugs.join(","),
      tags: tagSlugs.slice(0, 2).join(","),
      page_size: 30
    }));
  }

  if (tagSlugs.length) {
    requests.push(fetchGameList({ tags: tagSlugs.join(","), page_size: 30 }));
  }

  if (genreSlugs.length) {
    requests.push(fetchGameList({
      genres: genreSlugs.join(","),
      metacritic: "65,100",
      page_size: 24
    }));
  }

  const [series, ...others] = await Promise.all(requests);

  const seriesIds = new Set(series.map(item => String(item.id)));
  const myGenres = new Set(getGameGenres(game));
  const myTags = new Set((game.tags || []).map(tag => tag.id));

  const similarity = candidate => {
    let score = 0;

    getGameGenres(candidate).forEach(name => {
      if (myGenres.has(name)) score += 5;
    });

    const sharedTags = (candidate.tags || []).filter(tag => myTags.has(tag.id)).length;
    score += Math.min(sharedTags, 10) * 1.5;

    if (seriesIds.has(String(candidate.id))) score += 25;

    score += popularityScore(candidate) * 0.4;

    const metascore = getMetascore(candidate);
    if (metascore) score += Math.max(0, metascore - 60) * 0.25;

    return score;
  };

  return uniqueById([...series, ...others.flat()])
    .filter(candidate => String(candidate.id) !== String(game.id) && isQualityGame(candidate))
    .map(candidate => ({ candidate, score: similarity(candidate) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SIMILAR_SIZE)
    .map(item => item.candidate);
}

function getSimilarGames(game) {
  const key = String(game.id);

  if (similarCache.has(key)) {
    return Promise.resolve(similarCache.get(key));
  }

  if (!similarPending.has(key)) {
    similarPending.set(
      key,
      buildSimilarGames(game)
        .then(list => {
          similarCache.set(key, list);
          similarPending.delete(key);
          return list;
        })
        .catch(error => {
          similarPending.delete(key);
          throw error;
        })
    );
  }

  return similarPending.get(key);
}

function similarSectionHTML(list) {
  // Nothing found: leave the section out entirely.
  if (list && !list.length) return "";

  return `
    <section class="gn-detail-section" id="similar-section">
      <h3>Games you might also like</h3>
      <div class="gn-similar-grid" id="similar-grid">
        ${
          list
            ? cardsHTML(list)
            : `<div class="gn-loading">
                <span class="gn-spinner" aria-hidden="true"></span>
                <span>Finding similar games…</span>
              </div>`
        }
      </div>
    </section>
  `;
}

// Fills the section once the games arrive (ignored if you already moved on).
function fillSimilar(id, list) {
  if (currentView !== "details" || currentDetailsId !== String(id)) return;

  const section = $("#similar-section");
  const grid = $("#similar-grid");

  if (!section || !grid) return;

  currentSimilarGames = list;

  if (!list.length) {
    section.remove();
    return;
  }

  grid.innerHTML = cardsHTML(list);
}

/* -------------------- FILTERS AND SORTING -------------------- */

function getFilterState() {
  return {
    query: searchBar.value.trim(),
    genre: genreFilter.value,
    platform: platformFilter.value,
    minScore: metascoreFilter.value,
    year: yearFilter.value,
    sort: sortSelect.value
  };
}

function hasActiveFilters(filters) {
  return Boolean(
    filters.genre || filters.platform || filters.minScore || filters.year
  );
}

function fillSelect(select, options, firstLabel) {
  const previousValue = select.value;

  select.innerHTML = `<option value="">${escapeHTML(firstLabel)}</option>`;

  options.forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });

  if (options.some(option => option.value === previousValue)) {
    select.value = previousValue;
  }
}

// Fills the Sort menu with the options that make sense for this page.
function buildSortOptions(page) {
  const previous = sortSelect.value;
  const options = SORT_OPTIONS[page];

  sortSelect.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${escapeHTML(label)}</option>`)
    .join("");

  sortSelect.value = options.some(([value]) => value === previous)
    ? previous
    : DEFAULT_SORT[page];
}

async function loadFilterOptions() {
  try {
    const genres = await fetchRAWG("genres", { page_size: 40 });

    fillSelect(
      genreFilter,
      (genres.results || [])
        .map(item => ({ value: item.slug, label: item.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      "All genres"
    );
  } catch (error) {
    // The page remains usable even if filter metadata fails.
    console.warn("Game Note could not load filter options:", error);
  }
}

function resetFilters() {
  searchBar.value = "";
  genreFilter.value = "";
  platformFilter.value = "";
  metascoreFilter.value = "";
  yearFilter.value = "";
  sortSelect.value = DEFAULT_SORT[currentPage];
  currentApiPage = 1;
}

// Filters for the saved lists (Plan / Completed) work on the games you saved.
function filterSavedGames(games) {
  const filters = getFilterState();
  const query = filters.query.toLowerCase();

  return games.filter(game => {
    if (query) {
      const haystack = [
        game.name,
        ...getGameGenres(game),
        ...getGamePlatforms(game)
      ].join(" ").toLowerCase();

      if (!haystack.includes(query)) return false;
    }

    if (
      filters.genre &&
      !(game.genres || []).some(item => item?.slug === filters.genre)
    ) {
      return false;
    }

    if (
      filters.platform &&
      !(game.parents || []).map(String).includes(filters.platform)
    ) {
      return false;
    }

    if (filters.minScore) {
      const score = getMetascore(game);
      if (score === null || score < Number(filters.minScore)) return false;
    }

    if (filters.year && getReleaseYear(game) !== filters.year) return false;

    return true;
  });
}

function sortSavedGames(games) {
  const result = [...games];
  const sort = sortSelect.value;

  const priorityThenRecent = (a, b) =>
    Number(Boolean(b.priority)) - Number(Boolean(a.priority)) ||
    Number(b.addedAt || 0) - Number(a.addedAt || 0);

  if (sort === "az") {
    result.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  } else if (sort === "newest") {
    result.sort((a, b) => String(b.released || "").localeCompare(String(a.released || "")));
  } else if (sort === "oldest") {
    result.sort((a, b) => String(a.released || "9999").localeCompare(String(b.released || "9999")));
  } else if (sort === "metascore") {
    result.sort((a, b) => (getMetascore(b) || 0) - (getMetascore(a) || 0));
  } else if (sort === "rating") {
    result.sort((a, b) =>
      Number(b.rating || 0) - Number(a.rating || 0) || priorityThenRecent(a, b)
    );
  } else if (sort === "recent") {
    result.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
  } else {
    result.sort(priorityThenRecent);
  }

  return result;
}

/* -------------------- GAME CARDS -------------------- */

function cardActions(saved, id) {
  if (saved?.status === "plan") {
    return `
      <button class="gn-button gn-button-primary" data-action="complete" data-id="${id}" type="button">✓ Done</button>
      <button class="gn-button" data-action="remove" data-id="${id}" type="button">Remove</button>`;
  }

  if (saved?.status === "completed") {
    return `
      <button class="gn-button gn-button-primary" data-action="move-to-plan" data-id="${id}" type="button">↶ To Plan</button>
      <button class="gn-button" data-action="remove" data-id="${id}" type="button">Remove</button>`;
  }

  return `
    <button class="gn-button gn-button-primary" data-action="add" data-id="${id}" type="button">＋ Plan</button>
    <button class="gn-button" data-action="add-completed" data-id="${id}" type="button">✓ Done</button>`;
}

// `index` (0-based) adds the number shown in list view; leave it out for no number.
function cardHTML(game, savedMap, index = null) {
  const id = escapeHTML(game.id);
  const name = escapeHTML(game.name);
  const saved = savedMap.get(String(game.id));
  const genres = getGameGenres(game).slice(0, 2).join(" · ");
  const year = getReleaseYear(game) || "Year unknown";
  const score = getMetascore(game);
  const image = game.background_image || "";
  const isPriority = Boolean(saved?.priority);

  const scoreClass = score >= 75 ? "good" : score >= 50 ? "mixed" : "bad";

  let rightMeta = "";

  if (saved?.status === "completed" && saved.rating) {
    rightMeta = `<span class="gn-rating-chip">★ ${saved.rating}</span>`;
  } else if (saved) {
    rightMeta = `<span class="gn-status-chip ${saved.status}">${
      saved.status === "plan" ? "In Plan" : "Completed"
    }</span>`;
  }

  const number = index === null
    ? ""
    : `<span class="gn-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>`;

  return `
    <article class="gn-game-card">
      ${number}

      <div class="gn-cover-wrap">
        <button class="gn-cover-button"
          data-action="details" data-id="${id}" type="button"
          aria-label="View details for ${name}">
          ${
            image
              ? `<img class="gn-cover" src="${escapeHTML(cardImage(image))}" data-original="${escapeHTML(image)}" alt="" loading="lazy" decoding="async">`
              : `<span class="gn-cover-fallback">${name}</span>`
          }
        </button>

        <button class="gn-star ${isPriority ? "is-priority" : ""}"
          data-action="toggle-priority" data-id="${id}" type="button"
          aria-pressed="${isPriority}"
          aria-label="${isPriority ? "Remove priority from" : "Mark as priority:"} ${name}"
          title="${isPriority ? "Remove priority" : "Mark as priority"}">${isPriority ? "★" : "☆"}</button>

        ${
          score !== null
            ? `<span class="gn-badge ${scoreClass}" title="Metascore">${score}</span>`
            : ""
        }
      </div>

      <div class="gn-card-content">
        <h3 class="gn-card-title">
          <button class="gn-title-link" data-action="details" data-id="${id}" type="button">${name}</button>
        </h3>
        <p class="gn-card-subtitle">${escapeHTML(genres || "Video game")}</p>

        <div class="gn-card-meta">
          <span>${escapeHTML(year)}${saved?.note ? " · ✎" : ""}</span>
          ${rightMeta}
        </div>

        <div class="gn-card-actions">
          ${cardActions(saved, id)}
        </div>
      </div>
    </article>
  `;
}

function buildSavedMap() {
  return new Map(getSavedGames().map(game => [String(game.id), game]));
}

// Cards for a list of games. `startIndex` turns on numbering (used in list view).
function cardsHTML(games, startIndex = null, savedMap = buildSavedMap()) {
  return games
    .map((game, position) =>
      cardHTML(game, savedMap, startIndex === null ? null : startIndex + position)
    )
    .join("");
}

function renderGameCards(games, mode = "discover", { hasItems = false, startIndex = 0 } = {}) {
  syncGridLayout();

  if (!games.length) {
    let title;
    let message;
    let button;

    if (mode === "discover") {
      title = "No games found";
      message = "Try a different search, or reset the filters.";
      button = `<button class="button button-primary" data-action="reset" type="button">Reset filters</button>`;
    } else if (hasItems) {
      title = "No matches";
      message = "None of your saved games match the current search or filters.";
      button = `<button class="button button-primary" data-action="reset" type="button">Reset filters</button>`;
    } else {
      title = "Nothing here yet";
      message = mode === "completed"
        ? "Finished a game? Mark it as done and it will show up here."
        : "Games you add to your plan will appear here.";
      button = `<button class="button button-primary" data-action="go-discover" type="button">Discover games</button>`;
    }

    gamesGrid.innerHTML = `
      <div class="gn-empty">
        <h3>${title}</h3>
        <p>${message}</p>
        ${button}
      </div>
    `;

    return;
  }

  gamesGrid.innerHTML = cardsHTML(games, startIndex);
}

/* -------------------- DISCOVER PAGE -------------------- */

// Draws Discover from the games already in memory (no new request).
function renderDiscoverGames() {
  const filters = getFilterState();
  const browse = currentDiscoverMode === "browse";

  // Games you saved from the mix drop out of it; search results stay as they are.
  const savedIds = getSavedIds();

  const visible = browse
    ? currentDiscoverGames
    : currentDiscoverGames.filter(game => !savedIds.has(String(game.id)));

  renderGameCards(visible, "discover", {
    startIndex: browse ? (currentApiPage - 1) * PAGE_SIZE : 0
  });

  gridTitle.textContent = "Discover";

  if (filters.query) {
    feedEyebrow.textContent = "SEARCH RESULTS";
    feedDescription.textContent = `Results for “${filters.query}” from the RAWG game database.`;
  } else if (browse) {
    feedEyebrow.textContent = "FILTERED RESULTS";
    feedDescription.textContent = "Popular games matching your filters and sort order.";
  } else {
    feedEyebrow.textContent = "YOUR NEXT FAVORITE";
    feedDescription.textContent =
      "Fresh picks mixing what's popular, acclaimed, and shaped by your taste.";
  }

  resultsCount.textContent = countLabel(visible.length);

  if (browse && lastApiPage > 1) {
    pagination.hidden = false;
    pageIndicator.textContent = `Page ${currentApiPage} of ${lastApiPage}`;
    previousPageButton.disabled = currentApiPage <= 1;
    nextPageButton.disabled = currentApiPage >= lastApiPage;
  } else {
    pagination.hidden = true;
  }

  updateNavigationPill();
}

async function loadDiscover() {
  const thisRequest = ++requestNumber;
  currentView = "grid";
  currentDetailsId = null;

  const filters = getFilterState();
  const browse = Boolean(
    filters.query ||
    hasActiveFilters(filters) ||
    filters.sort !== DEFAULT_SORT.discover
  );

  pagination.hidden = true;
  showSkeletons();

  try {
    const feed = browse
      ? await buildBrowseFeed(filters, currentApiPage)
      : await buildMixFeed();

    if (thisRequest !== requestNumber) return;

    currentDiscoverMode = browse ? "browse" : "mix";

    // Searching shows everything; filters and sorting hide low-quality entries.
    currentDiscoverGames = browse && !filters.query
      ? feed.games.filter(isQualityGame)
      : feed.games;

    renderDiscoverGames();
  } catch (error) {
    if (thisRequest !== requestNumber) return;

    showMessage("Couldn't load games", error.message, true);
  }
}

/* -------------------- PLAN AND COMPLETED -------------------- */

// Older saved games may be missing genres/platforms; fill them in quietly.
async function hydrateSavedGames(games) {
  const targets = games.filter(game => !game.parentsLoaded).slice(0, 8);

  if (!targets.length) return false;

  const updates = new Map();

  await Promise.all(targets.map(async game => {
    try {
      updates.set(String(game.id), slimGame(await getCachedDetails(game.id)));
    } catch {
      // Keep locally saved information if RAWG is temporarily unavailable.
    }
  }));

  if (!updates.size) return false;

  saveGames(getSavedGames().map(item => {
    const update = updates.get(String(item.id));

    return update
      ? {
          ...item,
          genres: update.genres,
          platforms: update.platforms,
          parents: update.parents,
          parentsLoaded: true,
          metacritic: update.metacritic || item.metacritic,
          released: update.released || item.released,
          background_image: update.background_image || item.background_image
        }
      : item;
  }));

  return true;
}

function loadSavedList(status) {
  const thisRequest = ++requestNumber;
  currentView = "grid";
  currentDetailsId = null;

  pagination.hidden = true;

  const all = getSavedGames().filter(game => game.status === status);
  const shown = sortSavedGames(filterSavedGames(all));

  gridTitle.textContent = pageTitles[status];

  feedEyebrow.textContent = status === "completed"
    ? "YOUR ACCOMPLISHMENTS"
    : "UP NEXT";

  feedDescription.textContent = status === "completed"
    ? "The adventures you've finished."
    : "The games you're looking forward to playing.";

  renderGameCards(shown, status, { hasItems: all.length > 0 });

  resultsCount.textContent = shown.length === all.length
    ? countLabel(all.length)
    : `${shown.length} of ${countLabel(all.length)}`;

  updateNavigationPill();

  // Enrich older entries in the background; the first render isn't delayed.
  hydrateSavedGames(all).then(changed => {
    if (
      changed &&
      thisRequest === requestNumber &&
      currentView === "grid" &&
      currentPage === status
    ) {
      loadSavedList(status);
    }
  });
}

/* -------------------- GAME DETAILS -------------------- */

function getCachedDetails(id) {
  const key = String(id);

  if (!detailCache.has(key)) {
    detailCache.set(
      key,
      fetchRAWG(`games/${encodeURIComponent(id)}`)
        .catch(error => {
          detailCache.delete(key);
          throw error;
        })
    );
  }

  return detailCache.get(key);
}

function getCachedScreenshots(id) {
  const key = String(id);

  if (!screenshotCache.has(key)) {
    screenshotCache.set(
      key,
      fetchRAWG(`games/${encodeURIComponent(id)}/screenshots`, {
        page_size: 6
      }).catch(() => ({ results: [] }))
    );
  }

  return screenshotCache.get(key);
}

function renderDetailFacts(game, saved) {
  const genres = getGameGenres(game).join(", ") || "Not listed";
  const platforms = getGamePlatforms(game).slice(0, 6).join(", ") || "Not listed";
  const developers = (game.developers || []).map(item => item.name).join(", ") || "Not listed";
  const publishers = (game.publishers || []).map(item => item.name).join(", ") || "Not listed";
  const metascore = getMetascore(game);
  const playtime = Number(game.playtime) > 0 ? `About ${game.playtime} hours` : "Not available";

  const yourStatus = saved
    ? saved.status === "plan" ? "In Your Plan" : "Completed"
    : "Not saved";

  const facts = [
    ["Release date", formatReleaseDate(game)],
    ["Metascore", metascore === null ? "Not available" : `${metascore}/100`],
    ["Genres", genres],
    ["Platforms", platforms],
    ["Developer", developers],
    ["Publisher", publishers],
    ["Average playtime", playtime],
    ["Your status", yourStatus]
  ];

  return `
    <div class="gn-detail-facts">
      ${facts.map(([label, value]) => `
        <div class="gn-fact">
          <small>${label}</small>
          <strong>${escapeHTML(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderScreenshots(screenshots) {
  const items = (screenshots.results || [])
    .filter(item => item.image)
    .slice(0, 6);

  if (!items.length) return "";

  return `
    <section class="gn-detail-section">
      <h3>Screenshots</h3>
      <div class="gn-screenshot-grid">
        ${items.map((item, index) => `
          <a href="${escapeHTML(item.image)}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open screenshot ${index + 1} in a new tab">
            <img src="${escapeHTML(item.image)}"
              alt="Screenshot ${index + 1}"
              loading="lazy">
          </a>
        `).join("")}
      </div>
    </section>
  `;
}

function renderJournal(game, saved) {
  if (!saved) {
    return `
      <section class="gn-detail-section">
        <h3>Your notes</h3>
        <p class="gn-muted">
          Add this game to Your Plan or Completed to write notes and give it a rating.
        </p>
      </section>
    `;
  }

  const id = escapeHTML(game.id);

  return `
    <section class="gn-detail-section">
      <h3>Your notes</h3>

      <div class="gn-rating" role="group" aria-label="Your rating">
        <span class="gn-rating-label">Your rating</span>
        ${[1, 2, 3, 4, 5].map(value => `
          <button class="gn-rate ${value <= (saved.rating || 0) ? "is-on" : ""}"
            data-action="rate" data-id="${id}" data-value="${value}"
            aria-pressed="${value <= (saved.rating || 0)}"
            aria-label="${value} star${value > 1 ? "s" : ""}"
            type="button">★</button>
        `).join("")}
      </div>

      <textarea class="gn-note-input" data-note-input data-id="${id}"
        rows="4" maxlength="2000" aria-label="Your notes"
        placeholder="Thoughts, tips, where you left off…">${escapeHTML(saved.note || "")}</textarea>
      <p class="gn-note-status" id="note-status">Notes are saved on this device.</p>
    </section>
  `;
}

async function openGameDetails(id, { push = true, silent = false } = {}) {
  const thisRequest = ++requestNumber;

  // Remember where we were, and add a history step so the Back button closes details.
  if (push && currentView !== "details") {
    gridScroll = window.scrollY;

    try {
      history.pushState({ gnDetails: true }, "");
    } catch {
      // Back-button support is optional.
    }
  }

  currentView = "details";
  currentDetailsId = String(id);
  syncGridLayout();

  pagination.hidden = true;

  const backButton = `
    <button class="button button-quiet gn-back-button"
      data-action="back" type="button">
      ← Back to ${escapeHTML(pageTitles[currentPage])}
    </button>`;

  if (!silent) {
    gamesGrid.innerHTML = `
      ${backButton}
      <div class="gn-loading">
        <span class="gn-spinner" aria-hidden="true"></span>
        <span>Loading game details…</span>
      </div>
    `;

    if (push) scrollToFeed();
  }

  try {
    const [game, screenshots] = await Promise.all([
      getCachedDetails(id),
      getCachedScreenshots(id)
    ]);

    if (thisRequest !== requestNumber) return;

    const saved = findSavedGame(id);
    const gameId = escapeHTML(game.id);

    let description = (game.description_raw || cleanDescription(game.description || "")).trim();

    if (description.length > 1800) {
      description = `${description.slice(0, 1800).replace(/\s+\S*$/, "")}…`;
    }

    if (!description) {
      description = "No description is available for this game yet.";
    }

    let mainAction;

    if (saved?.status === "plan") {
      mainAction = `
        <button class="button button-primary" data-action="complete" data-id="${gameId}" type="button">✓ Mark completed</button>`;
    } else if (saved?.status === "completed") {
      mainAction = `
        <button class="button button-primary" data-action="move-to-plan" data-id="${gameId}" type="button">↶ Move to Plan</button>`;
    } else {
      mainAction = `
        <button class="button button-primary" data-action="add" data-id="${gameId}" type="button">＋ Add to Plan</button>
        <button class="button button-quiet" data-action="add-completed" data-id="${gameId}" type="button">✓ Add to Completed</button>`;
    }

    const priorityAction = `
      <button class="button button-quiet gn-priority-button ${saved?.priority ? "is-priority" : ""}"
        data-action="toggle-priority" data-id="${gameId}"
        aria-pressed="${Boolean(saved?.priority)}" type="button">
        ${saved?.priority ? "★ Priority" : "☆ Mark priority"}
      </button>`;

    const websiteAction = /^https?:\/\//i.test(game.website || "")
      ? `<a class="button button-quiet" href="${escapeHTML(game.website)}"
          target="_blank" rel="noopener noreferrer">Official site ↗</a>`
      : "";

    const tags = [
      ...getGameGenres(game).slice(0, 4),
      ...(game.esrb_rating?.name ? [game.esrb_rating.name] : [])
    ];

    // Already-loaded similar games show instantly (e.g. after adding one to a list).
    const cachedSimilar = similarCache.get(String(game.id));
    currentSimilarGames = cachedSimilar || [];

    gamesGrid.innerHTML = `
      ${backButton}

      <article class="gn-detail">
        <div class="gn-detail-top">
          ${
            game.background_image
              ? `<img class="gn-detail-art" src="${escapeHTML(game.background_image)}" alt="${escapeHTML(game.name)} artwork">`
              : `<div class="gn-detail-art gn-cover-fallback">${escapeHTML(game.name)}</div>`
          }

          <div class="gn-detail-info">
            <p class="eyebrow">GAME DETAILS</p>
            <h2>${escapeHTML(game.name)}</h2>

            <div class="gn-detail-tags">
              ${tags.map(tag => `<span class="gn-tag">${escapeHTML(tag)}</span>`).join("")}
            </div>

            <p class="gn-detail-description">${escapeHTML(description)}</p>

            ${renderDetailFacts(game, saved)}

            <div class="gn-detail-actions">
              ${mainAction}
              ${priorityAction}
              ${websiteAction}
              ${
                saved
                  ? `<button class="button button-quiet" data-action="remove" data-id="${gameId}" type="button">Remove from library</button>`
                  : ""
              }
            </div>

            <p class="gn-attribution">
              Game information and artwork provided by
              <a href="https://rawg.io/" target="_blank" rel="noopener noreferrer">RAWG</a>.
            </p>
          </div>
        </div>

        ${renderJournal(game, saved)}
        ${renderScreenshots(screenshots)}
        ${similarSectionHTML(cachedSimilar)}
      </article>
    `;

    resultsCount.textContent = game.name;

    if (!cachedSimilar) {
      getSimilarGames(game)
        .then(list => fillSimilar(game.id, list))
        .catch(() => fillSimilar(game.id, []));
    }
  } catch (error) {
    if (thisRequest !== requestNumber) return;

    gamesGrid.innerHTML = `
      ${backButton}
      <div class="gn-message">
        <h3>Couldn't load game details</h3>
        <p>${escapeHTML(error.message)}</p>
        <button class="button button-primary"
          data-action="retry-details" data-id="${escapeHTML(id)}" type="button">
          Try again
        </button>
      </div>
    `;
  }
}

// Goes back from details to the list, in the same place you left it.
function closeDetails() {
  currentDetailsId = null;
  currentView = "grid";
  requestNumber++;

  if (currentPage === "discover") {
    if (currentDiscoverGames.length) {
      renderDiscoverGames();
    } else {
      loadDiscover();
    }
  } else {
    loadSavedList(currentPage);
  }

  requestAnimationFrame(() => window.scrollTo(0, gridScroll));
}

function requestBack() {
  if (history.state?.gnDetails) {
    history.back(); // the popstate handler closes the details
  } else {
    closeDetails();
  }
}

/* -------------------- NAVIGATION -------------------- */

function updateNavigationPill() {
  if (!nav || !navIndicator) return;

  const active = nav.querySelector(".nav-button.active");
  if (!active) return;

  const navRect = nav.getBoundingClientRect();
  const buttonRect = active.getBoundingClientRect();

  navIndicator.style.width = `${buttonRect.width}px`;
  navIndicator.style.transform =
    `translateX(${buttonRect.left - navRect.left - nav.clientLeft}px)`;
}

function changePage(page) {
  if (!pageTitles[page]) return;

  currentPage = page;
  currentView = "grid";
  currentDetailsId = null;
  currentApiPage = 1;

  navButtons.forEach(button => {
    const active = button.dataset.page === page;

    button.classList.toggle("active", active);

    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  // Each page has its own Sort options and layout, and a search belongs to the page it was typed on.
  buildSortOptions(page);
  searchBar.value = "";
  syncGridLayout();

  renderCurrentPage();
  updateNavigationPill();
}

function renderCurrentPage() {
  currentView = "grid";

  if (currentPage === "discover") {
    loadDiscover();
  } else {
    loadSavedList(currentPage);
  }
}

function refreshCurrentView() {
  updateLibraryStats();

  if (currentView === "details" && currentDetailsId) {
    openGameDetails(currentDetailsId, { push: false, silent: true });
    return;
  }

  // On Discover, update using the games already in memory instead of reloading.
  if (currentPage === "discover" && currentDiscoverGames.length) {
    renderDiscoverGames();
    return;
  }

  renderCurrentPage();
}

/* -------------------- EVENT HANDLERS -------------------- */

navButtons.forEach(button => {
  button.addEventListener("click", () => {
    changePage(button.dataset.page);
  });
});

viewButtons.forEach(button => {
  button.addEventListener("click", () => {
    setViewMode(button.dataset.view);
  });
});

$("#brand-home").addEventListener("click", event => {
  event.preventDefault();
  changePage("discover");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

function handleSearchChange(delay) {
  clearTimeout(searchTimer);

  searchTimer = setTimeout(() => {
    currentApiPage = 1;
    renderCurrentPage();
  }, delay);
}

// Discover waits a little (it asks RAWG); saved lists filter instantly.
searchBar.addEventListener("input", () => {
  handleSearchChange(currentPage === "discover" ? 350 : 150);
});

[
  genreFilter,
  platformFilter,
  metascoreFilter,
  yearFilter,
  sortSelect
].forEach(control => {
  control.addEventListener("change", () => {
    currentApiPage = 1;
    renderCurrentPage();
  });
});

resetFiltersButton.addEventListener("click", () => {
  resetFilters();
  renderCurrentPage();
});

newMixButton.addEventListener("click", () => {
  mixSeed = Math.floor(Math.random() * 2 ** 32);
  discoveryCache.clear();
  resetFilters();
  changePage("discover");
  showNotice("Your Discover mix has been refreshed.");
});

addButton.addEventListener("click", () => {
  if (currentPage !== "discover" || currentView === "details") {
    changePage("discover");
  }

  searchBar.focus();
  showNotice("Search for a game, then choose where to add it.");
});

themeButton.addEventListener("click", () => {
  const isLight = document.body.classList.toggle("light-theme");
  applyThemeUI(isLight);

  try {
    localStorage.setItem(THEME_KEY, isLight ? "light" : "dark");
  } catch {
    // Theme switching still works if storage is unavailable.
  }
});

previousPageButton.addEventListener("click", () => {
  if (currentApiPage <= 1) return;

  currentApiPage -= 1;
  loadDiscover();
  scrollToFeed();
});

nextPageButton.addEventListener("click", () => {
  if (currentApiPage >= lastApiPage) return;

  currentApiPage += 1;
  loadDiscover();
  scrollToFeed();
});

exportButton.addEventListener("click", exportLibrary);
importButton.addEventListener("click", () => importInput.click());
importInput.addEventListener("change", () => importLibrary(importInput.files[0]));
clearButton.addEventListener("click", clearLibrary);

gamesGrid.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const { action, id } = button.dataset;

  switch (action) {
    case "retry":
      renderCurrentPage();
      break;

    case "go-discover":
      changePage("discover");
      break;

    case "reset":
      resetFilters();
      renderCurrentPage();
      break;

    case "back":
      requestBack();
      break;

    case "details":
      await openGameDetails(id);
      break;

    case "retry-details":
      await openGameDetails(id, { push: false });
      break;

    case "toggle-priority":
      await togglePriority(id);
      break;

    case "rate":
      setRating(id, Number(button.dataset.value));
      break;

    case "add":
    case "add-completed":
      try {
        addGame(
          await resolveGame(id),
          action === "add-completed" ? "completed" : "plan"
        );
      } catch (error) {
        showNotice(error.message);
      }
      break;

    case "complete":
      changeGameStatus(id, "completed");
      break;

    case "move-to-plan":
      changeGameStatus(id, "plan");
      break;

    case "remove":
      removeSavedGame(id);
      break;
  }
});

// Notes save as you type.
gamesGrid.addEventListener("input", event => {
  const box = event.target.closest("[data-note-input]");
  if (!box) return;

  saveNote(box.dataset.id, box.value);
});

// If an artwork link is broken, try the original image first, then show a friendly fallback.
gamesGrid.addEventListener("error", event => {
  const image = event.target;

  if (!(image instanceof HTMLImageElement)) return;

  if (image.classList.contains("gn-cover")) {
    const original = image.dataset.original;
    image.dataset.original = "";

    if (original && image.src !== original) {
      image.src = original;
      return;
    }

    image.remove();

    event.currentTarget
      .querySelectorAll(".gn-cover-button")
      .forEach(wrapper => {
        if (!wrapper.querySelector(".gn-cover")) {
          wrapper.classList.add("image-failed");
        }
      });
  }
}, true);

// Phone Back button / browser Back closes the details page.
window.addEventListener("popstate", () => {
  if (currentView === "details") {
    closeDetails();
  }
});

/* -------------------- KEYBOARD SHORTCUTS -------------------- */

document.addEventListener("keydown", event => {
  const tag = document.activeElement?.tagName;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);

  if (
    event.key === "/" &&
    !typing &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    searchBar.focus();
    searchBar.select();
    return;
  }

  if (event.key === "Escape") {
    if (document.activeElement === searchBar) {
      if (searchBar.value) {
        searchBar.value = "";
        handleSearchChange(0);
      } else {
        searchBar.blur();
      }
    } else if (currentView === "details" && !typing) {
      requestBack();
    }
  }
});

/* -------------------- INITIALIZATION -------------------- */

function applyThemeUI(isLight) {
  themeButton.innerHTML = `<span aria-hidden="true">${isLight ? "☀" : "☾"}</span>`;
  themeButton.setAttribute(
    "aria-label",
    isLight ? "Switch to dark theme" : "Switch to light theme"
  );

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", isLight ? "#f2f0f8" : "#000000");
}

function initializeTheme() {
  try {
    if (localStorage.getItem(THEME_KEY) === "light") {
      document.body.classList.add("light-theme");
      applyThemeUI(true);
    }
  } catch {
    // Default to the OLED dark theme.
  }
}

function initializeYearFilter() {
  const currentYear = new Date().getFullYear();

  for (let year = currentYear + 1; year >= 1970; year--) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    yearFilter.appendChild(option);
  }
}

window.addEventListener("resize", updateNavigationPill);
window.addEventListener("pageshow", updateNavigationPill);

// The pill needs the real font widths, so measure again once the font is ready.
document.fonts?.ready.then(updateNavigationPill);

initializeTheme();
initializeViewModes();
initializeYearFilter();
buildSortOptions("discover");
fillSelect(platformFilter, PLATFORM_OPTIONS, "All platforms");

// Always start clean after a refresh (the browser may try to restore old choices).
resetFilters();

updateLibraryStats();
updateNavigationPill();

// Load Discover first; filter metadata loads separately so it can't delay the feed.
loadDiscover();
loadFilterOptions();