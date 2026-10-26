/*
  GAME NOTE
  RAWG-powered game discovery and personal library.

  - Library key preserved: gameNoteSavedGames (your saved games carry over)
  - Discover mix: popularity + personal taste + rotating genre pools
  - Discover hides low-quality entries (no cover, symbol names, almost no players)
  - Sort options change per page; filters ask RAWG on Discover and
    filter your own list on Your Plan / Completed
  - Notes + star rating per saved game, undo, backup, keyboard shortcuts
*/

"use strict";

const API_BASE = `${window.location.origin}/api/rawg`;
const STORAGE_KEY = "gameNoteSavedGames";
const THEME_KEY = "gameNoteTheme";
const PAGE_SIZE = 24;
const DISCOVER_POOL_SIZE = 60;
const MIX_SIZE = 48;
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
const exportButton = $("#export-btn");
const importButton = $("#import-btn");
const importInput = $("#import-input");
const clearButton = $("#clear-btn");

const pageTitles = {
  discover: "Discover",
  plan: "Your Plan",
  completed: "Completed"
};

let currentPage = "discover";
let currentView = "grid";
let currentApiPage = 1;
let lastApiPage = 1;
let searchTimer;
let requestNumber = 0;
let mixSeed = Math.floor(Math.random() * 2 ** 32);
let currentDetailsId = null;
let currentDiscoverGames = [];
let currentDiscoverMode = "mix"; // "mix" or "browse"
let gridScroll = 0;

const detailCache = new Map();
const screenshotCache = new Map();
const discoveryCache = new Map();

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

function shuffleArray(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    mixSeed = (mixSeed * 1664525 + 1013904223) >>> 0;
    const j = mixSeed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
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

function getApiKey() {
  const key = window.RAWG_API_KEY;

  if (
    !key ||
    key === "PASTE_YOUR_RAWG_API_KEY_HERE" ||
    key === "placeholder"
  ) {
    throw new Error("Add your RAWG API key to config.js first.");
  }

  return key;
}

async function fetchRAWG(endpoint, params = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set("key", getApiKey());

  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, value);
    }
  });

  let response;

  try {
    response = await fetch(url);
  } catch {
    throw new Error("Couldn't reach RAWG. Check your internet connection and try again.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("RAWG rejected the request. Check your API key.");
  }

  if (response.status === 429) {
    throw new Error("RAWG's request limit was reached. Please try again later.");
  }

  if (!response.ok) {
    throw new Error(`RAWG request failed (${response.status}).`);
  }

  return response.json();
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

// Finds full game info from whatever we already have, or asks RAWG.
async function resolveGame(id) {
  return (
    findSavedGame(id) ||
    currentDiscoverGames.find(game => String(game.id) === String(id)) ||
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
  const saved = getSavedGames();
  const game = saved.find(item => String(item.id) === String(id));

  if (!game) {
    try {
      addGame(await resolveGame(id), "plan", true);
    } catch {
      showNotice("Couldn't load this game to mark it as a priority. Please try again.");
    }

    return;
  }

  game.priority = !game.priority;
  saveGames(saved);

  showNotice(
    game.priority
      ? `${game.name} marked as a priority.`
      : `${game.name} priority removed.`
  );

  refreshCurrentView();
}

function changeGameStatus(id, status) {
  const saved = getSavedGames();
  const game = saved.find(item => String(item.id) === String(id));

  if (!game) return;

  game.status = status;
  saveGames(saved);

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
  const saved = getSavedGames();
  const game = saved.find(item => String(item.id) === String(id));

  if (!game) return;

  game.rating = game.rating === value ? 0 : value;
  saveGames(saved);

  // Update the stars in place so the notes box keeps its focus.
  document.querySelectorAll(".gn-rate").forEach(star => {
    const on = Number(star.dataset.value) <= game.rating;
    star.classList.toggle("is-on", on);
    star.setAttribute("aria-pressed", String(on));
  });
}

function saveNote(id, text) {
  const saved = getSavedGames();
  const game = saved.find(item => String(item.id) === String(id));

  if (!game) return;

  game.note = text;
  saveGames(saved);

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

/* -------------------- PERSONALIZATION -------------------- */

function getTasteProfile() {
  const saved = getSavedGames();
  const genres = new Map();
  const platforms = new Map();

  saved.forEach(game => {
    const weight = game.status === "plan" ? 1.35 : 1;

    getGameGenres(game).forEach(name => {
      genres.set(name, (genres.get(name) || 0) + weight);
    });

    getGamePlatforms(game).forEach(name => {
      platforms.set(name, (platforms.get(name) || 0) + weight);
    });
  });

  return { genres, platforms };
}

function popularityScore(game) {
  const added = Math.max(0, Number(game.added || 0));
  const ratingsCount = Math.max(0, Number(game.ratings_count || 0));

  // Popularity metadata only; this deliberately doesn't use RAWG's user rating.
  return Math.log10(added + 1) * 12 +
    Math.log10(ratingsCount + 1) * 5;
}

function tasteScore(game, profile) {
  let score = 0;

  getGameGenres(game).forEach(name => {
    score += (profile.genres.get(name) || 0) * 7;
  });

  getGamePlatforms(game).forEach(name => {
    score += (profile.platforms.get(name) || 0) * 2;
  });

  return score;
}

function isEstablishedGame(game) {
  const added = Number(game.added || 0);
  const ratingsCount = Number(game.ratings_count || 0);

  return added >= 1000 || ratingsCount >= 150;
}

/* -------------------- DISCOVER FEED -------------------- */

async function fetchDiscoverPool(page = 1) {
  const cacheKey = String(page);

  if (discoveryCache.has(cacheKey)) {
    return discoveryCache.get(cacheKey);
  }

  const data = await fetchRAWG("games", {
    page,
    page_size: DISCOVER_POOL_SIZE,
    ordering: "-added",
    exclude_additions: true
  });

  const games = Array.isArray(data.results) ? data.results : [];

  discoveryCache.set(cacheKey, games);

  // Keep the in-memory cache bounded.
  if (discoveryCache.size > 30) {
    discoveryCache.delete(discoveryCache.keys().next().value);
  }

  return games;
}

async function fetchPersonalPools(profile) {
  const preferredGenres = [...profile.genres.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);

  if (!preferredGenres.length) return [];

  // The taste profile stores genre names; RAWG accepts slugs.
  const requests = preferredGenres.map(name =>
    fetchRAWG("games", {
      page_size: 24,
      ordering: "-added",
      exclude_additions: true,
      genres: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    }).catch(() => ({ results: [] }))
  );

  const responses = await Promise.all(requests);

  return responses.flatMap(result => result.results || []);
}

// The "Picked for you" mix: popular + personal + a little variety.
async function buildMixFeed() {
  const profile = getTasteProfile();

  const genreSlugs = [
    "action",
    "adventure",
    "indie",
    "role-playing-games-rpg",
    "strategy",
    "shooter",
    "platformer",
    "puzzle",
    "simulation",
    "racing",
    "sports",
    "casual"
  ];

  const genreOffset = mixSeed % genreSlugs.length;
  const popularPage = 1 + (mixSeed % 3);

  const rotatingGenres = [0, 1, 2].map(
    step => genreSlugs[(genreOffset + step * 3) % genreSlugs.length]
  );

  const [popularGames, personalGames, varietyResponses] = await Promise.all([
    fetchDiscoverPool(popularPage),
    fetchPersonalPools(profile),
    Promise.all(
      rotatingGenres.map(genre =>
        fetchRAWG("games", {
          page_size: 20,
          ordering: "-added",
          exclude_additions: true,
          genres: genre
        }).catch(() => ({ results: [] }))
      )
    )
  ]);

  const varietyGames = varietyResponses.flatMap(result => result.results || []);
  const savedIds = getSavedIds();

  const isUsable = game =>
    !savedIds.has(String(game.id)) && isQualityGame(game);

  const availablePopular = uniqueById(popularGames).filter(isUsable);

  const availablePersonal = uniqueById([...personalGames, ...varietyGames])
    .filter(isUsable);

  const established = availablePopular.filter(isEstablishedGame);
  const broaderPopular = availablePopular.filter(game => !isEstablishedGame(game));
  const mainPool = established.length >= 8 ? established : availablePopular;

  const personalizedRanked = availablePersonal
    .map(game => ({
      game,
      score: tasteScore(game, profile) + popularityScore(game)
    }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.game);

  const mainShuffled = shuffleArray(mainPool);
  const personalShuffled = shuffleArray(personalizedRanked);
  const broadShuffled = shuffleArray(broaderPopular);

  const popularTarget = Math.ceil(MIX_SIZE * 0.58);
  const personalTarget = Math.ceil(MIX_SIZE * 0.30);
  const broadTarget = MIX_SIZE - popularTarget - personalTarget;

  const selected = [
    ...mainShuffled.slice(0, popularTarget),
    ...personalShuffled.slice(0, personalTarget),
    ...broadShuffled.slice(0, broadTarget)
  ];

  const combined = uniqueById([
    ...selected,
    ...mainShuffled,
    ...personalShuffled,
    ...broadShuffled
  ]);

  const ranked = combined
    .map((game, index) => ({
      game,
      score: popularityScore(game) +
        tasteScore(game, profile) +
        ((index * 17 + mixSeed) % 13)
    }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.game);

  return { games: shuffleArray(ranked).slice(0, MIX_SIZE) };
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

function cardHTML(game, savedMap) {
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

  return `
    <article class="gn-game-card">
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

function renderGameCards(games, mode = "discover", { hasItems = false } = {}) {
  if (!games.length) {
    let title;
    let message;
    let button = "";

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

  const savedMap = new Map(
    getSavedGames().map(game => [String(game.id), game])
  );

  gamesGrid.innerHTML = games.map(game => cardHTML(game, savedMap)).join("");
}

/* -------------------- DISCOVER PAGE -------------------- */

// Draws Discover from the games already in memory (no new request).
function renderDiscoverGames() {
  const filters = getFilterState();
  const browse = currentDiscoverMode === "browse";
  const savedIds = getSavedIds();

  const visible = browse
    ? currentDiscoverGames
    : currentDiscoverGames.filter(game => !savedIds.has(String(game.id)));

  renderGameCards(visible, "discover");

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
      "Popular favorites, unexpected picks, and games shaped by your taste.";
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

async function getCachedDetails(id) {
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

async function getCachedScreenshots(id) {
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
      </article>
    `;

    resultsCount.textContent = game.name;
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

  // Each page has its own Sort options, and a search belongs to the page it was typed on.
  buildSortOptions(page);
  searchBar.value = "";

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

  if (action === "retry") {
    renderCurrentPage();
    return;
  }

  if (action === "go-discover") {
    changePage("discover");
    return;
  }

  if (action === "reset") {
    resetFilters();
    renderCurrentPage();
    return;
  }

  if (action === "back") {
    requestBack();
    return;
  }

  if (action === "details") {
    await openGameDetails(id);
    return;
  }

  if (action === "retry-details") {
    await openGameDetails(id, { push: false });
    return;
  }

  if (action === "toggle-priority") {
    await togglePriority(id);
    return;
  }

  if (action === "rate") {
    setRating(id, Number(button.dataset.value));
    return;
  }

  if (action === "add" || action === "add-completed") {
    try {
      addGame(
        await resolveGame(id),
        action === "add-completed" ? "completed" : "plan"
      );
    } catch (error) {
      showNotice(error.message);
    }

    return;
  }

  if (action === "complete") {
    changeGameStatus(id, "completed");
    return;
  }

  if (action === "move-to-plan") {
    changeGameStatus(id, "plan");
    return;
  }

  if (action === "remove") {
    removeSavedGame(id);
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