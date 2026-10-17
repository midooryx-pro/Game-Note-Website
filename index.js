
/* =========================================================
   GAME NOTE - index.js
   FreeToGame API + Discover + Details + My Library
   ========================================================= */

const API = "https://www.freetogame.com/api";
const STORAGE_KEY = "gameNoteLibraryV1";

const nav = document.querySelector(".nav");
const navButtons = document.querySelectorAll(".nav-btn");
const gridTitle = document.querySelector("#grid-title");
const gamesGrid = document.querySelector("#games-grid");
const searchBar = document.querySelector("#search-bar");
const addButton = document.querySelector("#add-btn");

const genreFilter = document.querySelector("#genre-filter");
const platformFilter = document.querySelector("#platform-filter");
const ratingFilter = document.querySelector("#rating-filter");
const sortSelect = document.querySelector("#sort");

const DEFAULT_LISTS = [
    { id: "plan", name: "Plan to Play", builtIn: true },
    { id: "completed", name: "Completed", builtIn: true },
    { id: "favorites", name: "Favorites", builtIn: true }
];

let catalog = [];
let currentPage = "discover";
let currentView = "grid";
let activeListId = null;
let lastSearch = "";
let requestId = 0;
let searchTimer = null;

/* ---------- 1. HELPERS ---------- */

function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function getLibrary() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

        if (
            saved &&
            Array.isArray(saved.lists) &&
            saved.memberships &&
            saved.games
        ) {
            return saved;
        }
    } catch (error) {
        console.warn("Could not read saved library:", error);
    }

    return {
        lists: DEFAULT_LISTS.map(list => ({ ...list })),
        games: {},
        memberships: {
            plan: [],
            completed: [],
            favorites: []
        }
    };
}

function saveLibrary(library) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
        return true;
    } catch (error) {
        showNotice("Couldn't save your library. Browser storage may be full.");
        console.error(error);
        return false;
    }
}

function getList(id) {
    return getLibrary().lists.find(list => list.id === id);
}

function getListGames(listId) {
    const library = getLibrary();
    const ids = library.memberships[listId] || [];

    return ids
        .map(id => library.games[String(id)])
        .filter(Boolean);
}

function cleanText(html = "") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent.trim();
}

function getGenreNames(game) {
    if (Array.isArray(game.genre)) return game.genre;
    if (typeof game.genre === "string") return [game.genre];
    return [];
}

function getPlatformName(game) {
    return String(game.platform || "");
}

/* ---------- 2. API ---------- */

async function apiRequest(endpoint) {
    const response = await fetch(`${API}/${endpoint}`);

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error("The requested game was not found.");
        }

        if (response.status === 429) {
            throw new Error("Too many requests. Wait a little and try again.");
        }

        throw new Error(`The game service returned error ${response.status}.`);
    }

    return response.json();
}

async function loadCatalog() {
    if (catalog.length) return catalog;

    showLoading("Loading the game catalog...");

    try {
        const games = await apiRequest("games");

        if (!Array.isArray(games)) {
            throw new Error("The API returned an unexpected response.");
        }

        catalog = games;
        populateFilters();
        return catalog;
    } catch (error) {
        showMessage(
            "Couldn't load games",
            `${error.message} Check your connection and try again.`,
            true
        );

        throw error;
    }
}

async function getGameDetails(id) {
    return apiRequest(`game?id=${encodeURIComponent(id)}`);
}

/* ---------- 3. NOTICES AND STATES ---------- */

function showNotice(message) {
    let notice = document.querySelector("#gn-notice");

    if (!notice) {
        notice = document.createElement("div");
        notice.id = "gn-notice";
        notice.className = "gn-notice";
        notice.setAttribute("role", "status");
        document.body.appendChild(notice);
    }

    notice.textContent = message;
    notice.classList.add("is-visible");

    clearTimeout(notice.timer);

    notice.timer = setTimeout(() => {
        notice.classList.remove("is-visible");
    }, 2600);
}

function showLoading(message = "Loading...") {
    gamesGrid.innerHTML = `
        <div class="gn-message">
            <span class="gn-spinner"></span>
            <p>${escapeHTML(message)}</p>
        </div>
    `;
}

function showMessage(title, message, retry = false) {
    gamesGrid.innerHTML = `
        <div class="gn-message">
            <h3>${escapeHTML(title)}</h3>
            <p>${escapeHTML(message)}</p>
            ${retry ? `
                <button class="gn-button" data-action="retry">
                    Try again
                </button>
            ` : ""}
        </div>
    `;
}

/* ---------- 4. FILTER OPTIONS ---------- */

function populateFilters() {
    if (genreFilter) {
        const genres = [...new Set(
            catalog.map(game => game.genre).filter(Boolean)
        )].sort((a, b) => a.localeCompare(b));

        genreFilter.innerHTML =
            '<option value="">All genres</option>' +
            genres.map(genre =>
                `<option value="${escapeHTML(genre)}">${escapeHTML(genre)}</option>`
            ).join("");
    }

    if (platformFilter) {
        platformFilter.innerHTML = `
            <option value="">All platforms</option>
            <option value="pc">PC</option>
            <option value="browser">Browser</option>
        `;
    }

    if (ratingFilter) {
        ratingFilter.innerHTML = `
            <option value="">Any minimum score</option>
            <option value="4">4+ rating</option>
            <option value="3">3+ rating</option>
            <option value="2">2+ rating</option>
        `;
    }

    if (sortSelect) {
        sortSelect.innerHTML = `
            <option value="popular">Popularity</option>
            <option value="alphabetical">Alphabetical</option>
            <option value="release-date">Release date</option>
        `;
    }
}

function resetFilters() {
    if (searchBar) searchBar.value = "";
    if (genreFilter) genreFilter.value = "";
    if (platformFilter) platformFilter.value = "";
    if (ratingFilter) ratingFilter.value = "";
    if (sortSelect) sortSelect.value = "popular";
}

/* ---------- 5. SEARCH AND FILTER ---------- */

function getFilteredCatalog() {
    const query = (searchBar?.value || "").trim().toLowerCase();
    const genre = genreFilter?.value || "";
    const platform = platformFilter?.value || "";
    const minRating = Number(ratingFilter?.value || 0);
    const sort = sortSelect?.value || "popular";

    let results = catalog.filter(game => {
        const title = String(game.title || "").toLowerCase();
        const description = String(game.short_description || "").toLowerCase();

        const matchesSearch =
            !query || title.includes(query) || description.includes(query);

        const matchesGenre = !genre || game.genre === genre;

        const platformText = getPlatformName(game).toLowerCase();
        const matchesPlatform = !platform ||
            platformText.includes(platform);

        const rating = Number(game.rating || 0);
        const matchesRating = !minRating || rating >= minRating;

        return matchesSearch &&
            matchesGenre &&
            matchesPlatform &&
            matchesRating;
    });

    if (sort === "alphabetical") {
        results.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === "release-date") {
        results.sort((a, b) =>
            String(b.release_date || "").localeCompare(String(a.release_date || ""))
        );
    } else {
        results.sort((a, b) =>
            Number(b.rating || 0) - Number(a.rating || 0)
        );
    }

    return results;
}

/* ---------- 6. GAME CARDS ---------- */

function renderGameCards(games, context = "discover") {
    if (!games.length) {
        showMessage(
            "No games found",
            context === "discover"
                ? "Try a different search or adjust your filters."
                : "This list is empty. Find a game in Discover and add it here."
        );
        return;
    }

    gamesGrid.innerHTML = games.map(game => {
        const id = String(game.id);
        const title = game.title || game.name || "Untitled game";
        const image = game.thumbnail || game.background_image || "";
        const genre = getGenreNames(game).join(", ") || "Genre unknown";
        const release = game.release_date || game.released || "Release date unknown";
        const rating = Number(game.rating || 0);

        let action = "";

        if (context === "list") {
            action = `
                <button class="gn-button gn-button-secondary"
                    data-action="remove-from-list"
                    data-id="${escapeHTML(id)}">
                    Remove
                </button>
            `;
        } else {
            action = `
                <button class="gn-button gn-button-secondary"
                    data-action="add-to-list"
                    data-id="${escapeHTML(id)}">
                    + Add
                </button>
            `;
        }

        return `
            <article class="gn-game-card">
                <button class="gn-cover-button"
                    data-action="details"
                    data-id="${escapeHTML(id)}"
                    aria-label="View ${escapeHTML(title)} details">
                    ${
                        image
                            ? `<img class="gn-cover"
                                src="${escapeHTML(image)}"
                                alt="${escapeHTML(title)} artwork"
                                loading="lazy">`
                            : `<div class="gn-cover gn-no-cover">No cover available</div>`
                    }
                </button>

                <div class="gn-card-content">
                    <h3>${escapeHTML(title)}</h3>
                    <p class="gn-muted">${escapeHTML(genre)}</p>

                    <div class="gn-card-meta">
                        <span>${escapeHTML(release)}</span>
                        <span>★ ${rating ? rating.toFixed(1) : "—"}</span>
                    </div>

                    <div class="gn-card-actions">
                        <button class="gn-button gn-button-secondary"
                            data-action="details"
                            data-id="${escapeHTML(id)}">
                            Details
                        </button>
                        ${action}
                    </div>
                </div>
            </article>
        `;
    }).join("");
}

/* ---------- 7. DISCOVER ---------- */

async function renderDiscover() {
    currentPage = "discover";
    currentView = "grid";
    activeListId = null;

    const thisRequest = ++requestId;

    try {
        await loadCatalog();

        if (thisRequest !== requestId) return;

        renderGameCards(getFilteredCatalog(), "discover");
    } catch {
        // loadCatalog already displays an error message.
    }
}

function applyFilters() {
    if (currentPage !== "discover" || currentView !== "grid") return;

    renderGameCards(getFilteredCatalog(), "discover");
}

[genreFilter, platformFilter, ratingFilter, sortSelect]
    .filter(Boolean)
    .forEach(control => {
        control.addEventListener("change", applyFilters);
    });

if (searchBar) {
    searchBar.addEventListener("input", () => {
        if (currentPage !== "discover") {
            changePage("discover");
        }

        clearTimeout(searchTimer);

        searchTimer = setTimeout(() => {
            if (currentPage === "discover" && currentView === "grid") {
                applyFilters();
            }
        }, 180);
    });
}

/* ---------- 8. SAVE A GAME AND ADD TO A LIST ---------- */

function saveGameToList(game, listId) {
    const library = getLibrary();
    const id = String(game.id);

    if (!library.lists.some(list => list.id === listId)) {
        showNotice("That list no longer exists.");
        return;
    }

    library.games[id] = {
        ...library.games[id],
        ...game,
        id: game.id
    };

    if (!library.memberships[listId]) {
        library.memberships[listId] = [];
    }

    if (library.memberships[listId].some(item => String(item) === id)) {
        showNotice("This game is already in that list.");
        return;
    }

    library.memberships[listId].push(game.id);

    if (saveLibrary(library)) {
        const list = library.lists.find(item => item.id === listId);
        showNotice(`Added to ${list.name}.`);
    }
}

function getGameFromCatalog(id) {
    return catalog.find(game => String(game.id) === String(id));
}

async function openAddToList(id) {
    let game = getGameFromCatalog(id);

    if (!game) {
        game = getLibrary().games[String(id)];
    }

    if (!game) {
        try {
            game = await getGameDetails(id);
        } catch (error) {
            showNotice(error.message);
            return;
        }
    }

    const lists = getLibrary().lists;

    const options = lists.map(list => `
        <button class="gn-list-option"
            data-action="confirm-add"
            data-id="${escapeHTML(id)}"
            data-list-id="${escapeHTML(list.id)}">
            <span>${escapeHTML(list.name)}</span>
            <span>+</span>
        </button>
    `).join("");

    gamesGrid.innerHTML = `
        <section class="gn-list-picker">
            <button class="gn-button gn-button-secondary"
                data-action="back">
                ← Back
            </button>

            <h2>Add ${escapeHTML(game.title || game.name)} to...</h2>
            <p class="gn-muted">Choose one of your lists.</p>

            <div class="gn-list-options">
                ${options}
            </div>

            <button class="gn-button"
                data-action="manage-lists">
                Manage my lists
            </button>
        </section>
    `;

    currentView = "add-picker";
}

/* ---------- 9. GAME DETAILS ---------- */

async function openGameDetails(id) {
    const thisRequest = ++requestId;

    currentView = "details";
    showLoading("Loading game details...");

    try {
        const game = await getGameDetails(id);

        if (thisRequest !== requestId) return;

        const description = cleanText(
            game.description || game.short_description || ""
        );

        const screenshots = Array.isArray(game.screenshots)
            ? game.screenshots
            : [];

        gamesGrid.innerHTML = `
            <section class="gn-detail">
                <button class="gn-button gn-button-secondary"
                    data-action="back">
                    ← Back
                </button>

                <div class="gn-detail-layout">
                    <div class="gn-detail-art">
                        ${
                            game.thumbnail
                                ? `<img src="${escapeHTML(game.thumbnail)}"
                                    alt="${escapeHTML(game.title)} artwork">`
                                : `<div class="gn-no-cover">No cover available</div>`
                        }
                    </div>

                    <div class="gn-detail-info">
                        <p class="gn-eyebrow">GAME DETAILS</p>
                        <h2>${escapeHTML(game.title || "Untitled game")}</h2>

                        <p class="gn-detail-description">
                            ${escapeHTML(description || "No description is available.")}
                        </p>

                        <dl class="gn-facts">
                            <div>
                                <dt>Genre</dt>
                                <dd>${escapeHTML(game.genre || "Unknown")}</dd>
                            </div>
                            <div>
                                <dt>Platform</dt>
                                <dd>${escapeHTML(game.platform || "Unknown")}</dd>
                            </div>
                            <div>
                                <dt>Release date</dt>
                                <dd>${escapeHTML(game.release_date || "Unknown")}</dd>
                            </div>
                            <div>
                                <dt>Developer</dt>
                                <dd>${escapeHTML(game.developer || "Unknown")}</dd>
                            </div>
                            <div>
                                <dt>Publisher</dt>
                                <dd>${escapeHTML(game.publisher || "Unknown")}</dd>
                            </div>
                        </dl>

                        <button class="gn-button gn-add-detail"
                            data-action="add-to-list"
                            data-id="${escapeHTML(game.id)}">
                            + Add to a list
                        </button>

                        ${
                            game.game_url
                                ? `<p class="gn-attribution">
                                    <a href="${escapeHTML(game.game_url)}"
                                        target="_blank"
                                        rel="noopener noreferrer">
                                        Official game page ↗
                                    </a>
                                   </p>`
                                : ""
                        }

                        ${
                            screenshots.length
                                ? `<h3 class="gn-screenshot-title">Screenshots</h3>
                                   <div class="gn-screenshots">
                                     ${screenshots.map(screenshot => `
                                        <img src="${escapeHTML(screenshot.image)}"
                                            alt="${escapeHTML(game.title)} screenshot"
                                            loading="lazy">
                                     `).join("")}
                                   </div>`
                                : ""
                        }

                        <p class="gn-attribution">
                            Game data provided by
                            <a href="https://www.freetogame.com/"
                                target="_blank"
                                rel="noopener noreferrer">FreeToGame</a>.
                        </p>
                    </div>
                </div>
            </section>
        `;

        // Store full detail data for future use in the user's library.
        const library = getLibrary();
        library.games[String(game.id)] = {
            ...library.games[String(game.id)],
            ...game
        };
        saveLibrary(library);

    } catch (error) {
        if (thisRequest !== requestId) return;

        showMessage("Couldn't load game details", error.message, true);
    }
}

/* ---------- 10. MY LIBRARY / LIST MANAGEMENT ---------- */

function openLibraryManager() {
    currentPage = "library";
    currentView = "library";
    activeListId = null;

    const lists = getLibrary().lists;

    gridTitle.textContent = "My Library";

    gamesGrid.innerHTML = `
        <section class="gn-library">
            <div class="gn-library-heading">
                <div>
                    <p class="gn-eyebrow">YOUR COLLECTION</p>
                    <h2>My Lists</h2>
                    <p class="gn-muted">
                        Organize games your way. Your lists are saved in this browser.
                    </p>
                </div>

                <button class="gn-button"
                    data-action="create-list">
                    + New List
                </button>
            </div>

            <div class="gn-list-manager">
                ${lists.map(list => {
                    const count = (getLibrary().memberships[list.id] || []).length;

                    return `
                        <article class="gn-list-card">
                            <button class="gn-list-open"
                                data-action="open-list"
                                data-list-id="${escapeHTML(list.id)}">
                                <span class="gn-list-icon">▤</span>
                                <span class="gn-list-copy">
                                    <strong>${escapeHTML(list.name)}</strong>
                                    <small>${count} ${count === 1 ? "game" : "games"}</small>
                                </span>
                                <span class="gn-list-arrow">→</span>
                            </button>

                            <div class="gn-list-manage-actions">
                                <button class="gn-button gn-button-secondary"
                                    data-action="rename-list"
                                    data-list-id="${escapeHTML(list.id)}">
                                    Rename
                                </button>

                                ${
                                    list.builtIn
                                        ? `<span class="gn-built-in">Default</span>`
                                        : `<button class="gn-button gn-button-danger"
                                            data-action="delete-list"
                                            data-list-id="${escapeHTML(list.id)}">
                                            Delete
                                          </button>`
                                }
                            </div>
                        </article>
                    `;
                }).join("")}
            </div>

            <button class="gn-button gn-button-secondary"
                data-action="back-to-discover">
                Explore games
            </button>
        </section>
    `;
}

function openList(listId) {
    const list = getList(listId);

    if (!list) {
        showNotice("List not found.");
        openLibraryManager();
        return;
    }

    currentPage = "library";
    currentView = "list";
    activeListId = listId;

    gridTitle.textContent = list.name;

    const games = getListGames(listId);

    gamesGrid.innerHTML = `
        <section class="gn-list-page">
            <div class="gn-list-page-heading">
                <button class="gn-button gn-button-secondary"
                    data-action="manage-lists">
                    ← My Lists
                </button>

                <h2>${escapeHTML(list.name)}</h2>
                <p class="gn-muted">${games.length} saved games</p>
            </div>

            <div class="gn-games-list">
                ${
                    games.length
                        ? games.map(game => `
                            <article class="gn-saved-game">
                                <button class="gn-saved-game-main"
                                    data-action="details"
                                    data-id="${escapeHTML(game.id)}">
                                    ${
                                        game.thumbnail
                                            ? `<img src="${escapeHTML(game.thumbnail)}"
                                                alt="" loading="lazy">`
                                            : `<div class="gn-saved-placeholder">🎮</div>`
                                    }
                                    <span>
                                        <strong>${escapeHTML(game.title || game.name)}</strong>
                                        <small>${escapeHTML(game.genre || "Game")}</small>
                                    </span>
                                </button>

                                <button class="gn-button gn-button-danger"
                                    data-action="remove-from-list"
                                    data-id="${escapeHTML(game.id)}"
                                    data-list-id="${escapeHTML(listId)}">
                                    Remove
                                </button>
                            </article>
                        `).join("")
                        : `<div class="gn-message">
                            <h3>This list is empty</h3>
                            <p>Find a game and add it to this list.</p>
                           </div>`
                }
            </div>

            <button class="gn-button"
                data-action="go-discover">
                + Find games
            </button>
        </section>
    `;
}

function createList() {
    const name = prompt("What would you like to call your new list?");

    if (name === null) return;

    const cleanName = name.trim();

    if (!cleanName) {
        showNotice("Enter a list name first.");
        return;
    }

    const library = getLibrary();

    if (library.lists.some(
        list => list.name.toLowerCase() === cleanName.toLowerCase()
    )) {
        showNotice("A list with that name already exists.");
        return;
    }

    const id = `custom-${Date.now()}`;

    library.lists.push({
        id,
        name: cleanName,
        builtIn: false
    });

    library.memberships[id] = [];

    if (saveLibrary(library)) {
        showNotice("Your new list is ready.");
        openLibraryManager();
    }
}

function renameList(listId) {
    const library = getLibrary();
    const list = library.lists.find(item => item.id === listId);

    if (!list) return;

    const name = prompt("Enter a new list name:", list.name);

    if (name === null) return;

    const cleanName = name.trim();

    if (!cleanName) {
        showNotice("List name can't be empty.");
        return;
    }

    if (library.lists.some(
        item => item.id !== listId &&
            item.name.toLowerCase() === cleanName.toLowerCase()
    )) {
        showNotice("A list with that name already exists.");
        return;
    }

    list.name = cleanName;

    if (saveLibrary(library)) {
        openLibraryManager();
        showNotice("List renamed.");
    }
}

function deleteList(listId) {
    const library = getLibrary();
    const list = library.lists.find(item => item.id === listId);

    if (!list || list.builtIn) return;

    if (!confirm(`Delete "${list.name}" and remove all its saved games from this list?`)) {
        return;
    }

    library.lists = library.lists.filter(item => item.id !== listId);
    delete library.memberships[listId];

    if (saveLibrary(library)) {
        openLibraryManager();
        showNotice("List deleted.");
    }
}

function removeGameFromList(gameId, listId) {
    const library = getLibrary();
    const key = listId || activeListId;

    if (!key || !library.memberships[key]) return;

    library.memberships[key] = library.memberships[key].filter(
        id => String(id) !== String(gameId)
    );

    if (saveLibrary(library)) {
        showNotice("Game removed from list.");
        openList(key);
    }
}

/* ---------- 11. NAVIGATION ---------- */

function updateNavigationPill() {
    if (!nav) return;

    const active = nav.querySelector(".nav-btn.active");
    if (!active) return;

    const navRect = nav.getBoundingClientRect();
    const buttonRect = active.getBoundingClientRect();
    const x = buttonRect.left - navRect.left - nav.clientLeft;

    nav.style.setProperty("--pill-x", `${x}px`);
    nav.style.setProperty("--pill-width", `${buttonRect.width}px`);
}

function changePage(page) {
    if (!["discover", "plan", "completed"].includes(page)) return;

    currentPage = page;
    currentView = "grid";
    activeListId = null;

    navButtons.forEach(button => {
        const active = button.dataset.page === page;

        button.classList.toggle("active", active);

        if (active) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });

    gridTitle.textContent = page === "plan"
        ? "Plan to Play"
        : pageTitlesForNavigation(page);

    updateNavigationPill();

    if (page === "discover") {
        renderDiscover();
        return;
    }

    const listId = page === "plan" ? "plan" : "completed";
    openList(listId);
}

function pageTitlesForNavigation(page) {
    return {
        discover: "Discover",
        plan: "Plan to Play",
        completed: "Completed"
    }[page];
}

navButtons.forEach(button => {
    button.addEventListener("click", () => {
        changePage(button.dataset.page);
    });
});

/* ---------- 12. TOP ADD GAME BUTTON ---------- */

if (addButton) {
    addButton.addEventListener("click", openLibraryManager);
}

/* ---------- 13. ALL GRID ACTIONS ---------- */

gamesGrid.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const id = button.dataset.id;
    const listId = button.dataset.listId;

    switch (action) {
        case "retry":
            if (currentView === "details" && id) {
                openGameDetails(id);
            } else {
                catalog = [];
                renderDiscover();
            }
            break;

        case "details":
            await openGameDetails(id);
            break;

        case "add-to-list":
            await openAddToList(id);
            break;

        case "confirm-add": {
            const game = getGameFromCatalog(id) ||
                getLibrary().games[String(id)];

            if (game) {
                saveGameToList(game, listId);
                openList(listId);
            }
            break;
        }

        case "back":
            if (currentPage === "library" && activeListId) {
                openList(activeListId);
            } else if (currentPage === "discover") {
                renderDiscover();
            } else {
                openLibraryManager();
            }
            break;

        case "create-list":
            createList();
            break;

        case "open-list":
            openList(listId);
            break;

        case "manage-lists":
            openLibraryManager();
            break;

        case "rename-list":
            renameList(listId);
            break;

        case "delete-list":
            deleteList(listId);
            break;

        case "remove-from-list":
            removeGameFromList(id, listId);
            break;

        case "back-to-discover":
        case "go-discover":
            changePage("discover");
            break;
    }
});

/* ---------- 14. STARTUP ---------- */

const pageTitles = {
    discover: "Discover",
    plan: "Plan to Play",
    completed: "Completed"
};

resetFilters();

navButtons.forEach(button => {
    button.classList.toggle(
        "active",
        button.dataset.page === "discover"
    );
});

changePage("discover");

requestAnimationFrame(updateNavigationPill);
window.addEventListener("resize", updateNavigationPill);
