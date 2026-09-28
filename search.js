const DISPLAY_LIMIT = 100;  // Limit the number of results displayed
const SCROLL_AMOUNT = 5;  // Amount to scroll when Ctrl-u is pressed
const FUZZYSORT_THRESHOLD = 0;  // Minimum score for fuzzysort matches
const ARCHIVE_FOLDER_NAME = '__fzf_archive__';  // Folder in Other Bookmarks that holds archived bookmarks
const STATUS_DURATION = 3000;  // How long status messages stay visible, in milliseconds

let selectedIndex = 0;  // Keep track of the selected index

let bookmarks = [];  // Active bookmarks
let archivedBookmarks = [];  // Bookmarks inside the archive folder
let topLevelFolders = [];  // Chrome's permanent folders (Bookmarks Bar, Other Bookmarks, ...)
let archiveMode = false;  // Whether the archive is being shown instead of the active bookmarks
let busy = false;  // Prevent overlapping archive/restore operations


function displayItems(items, titleResults, urlResults) {
    // Clear the previous results
    const resultsDiv = document.getElementById('results');
    while (resultsDiv.firstChild) {
        resultsDiv.removeChild(resultsDiv.firstChild);
    }

    // If there are no results, display a message
    if (items.length === 0) {
        const div = document.createElement('div');
        div.textContent = "No results found.";
        resultsDiv.appendChild(div);
        return;
    }

    // Display the new results
    items.forEach(function(item, i) {
        const div = document.createElement('div');
        const a = document.createElement('a');
        const favicon = `<img src="https://www.google.com/s2/favicons?domain=${item.url}" class="favicon">`

        let titleText = item.displayTitle;
        let urlText = item.url;

        // Highlight title if title results are provided
        if (titleResults) {
            titleText = fuzzysort.highlight(titleResults[i], '<span class="highlight">', '</span>');
        }

        // Highlight URL if URL results are provided
        if (urlResults) {
            // Find the matching URL result for this item
            const urlResult = urlResults.find(result => result.obj === item);
            if (urlResult) {
                urlText = fuzzysort.highlight(urlResult, '<span class="highlight">', '</span>');
            }
        }

        const url_text = `&nbsp;&nbsp;&nbsp;&nbsp;<span class="url">${urlText}</span>`;
        div.innerHTML = favicon + `<span class="text">${titleText}${url_text}</span>`;

        a.href = item.url;
        a.appendChild(div);
        if (i === selectedIndex) {
            // If this is the selected item, add the selected class
            div.classList.add('selected');
            // Scroll the selected item into the middle of the resultsDiv
            setTimeout(() => {
                resultsDiv.scrollTop = div.offsetTop - resultsDiv.offsetHeight / 2 + div.offsetHeight / 2;
            }, 0);
        }
        resultsDiv.appendChild(a);
    });
}


function updateResultsInfo(results, timeTaken) {
    const resultsInfoSpan = document.getElementById('resultsInfoText');
    resultsInfoSpan.textContent = `found ${results.length} results in ${timeTaken} seconds`;

    const archiveToggle = document.getElementById('archiveToggleText');
    archiveToggle.textContent = archiveMode ? `bookmarks (${bookmarks.length})` : `archive (${archivedBookmarks.length})`;
}


function showStatus(message) {
    const statusSpan = document.getElementById('statusText');
    statusSpan.textContent = message;
    clearTimeout(showStatus.timeout);
    showStatus.timeout = setTimeout(() => {
        statusSpan.textContent = '';
    }, STATUS_DURATION);
}


function isBookmarksBar(node) {
    return node.folderType === 'bookmarks-bar' || (!node.folderType && node.id === '1');
}


function isArchiveFolder(node) {
    return !node.url && node.title === ARCHIVE_FOLDER_NAME;
}


// Find the Other Bookmarks folder (shown as "All Bookmarks" in newer Chrome), preferring the synced copy
function findOtherBookmarks() {
    const others = topLevelFolders.filter(node => node.folderType === 'other');
    if (others.length > 0) {
        return others.find(node => node.syncing) || others[0];
    }
    return topLevelFolders.find(node => node.id === '2') || topLevelFolders[topLevelFolders.length - 1];
}


// Load all bookmarks, splitting them into active and archived
async function loadBookmarks() {
    const [root] = await chrome.bookmarks.getTree();
    topLevelFolders = root.children || [];
    bookmarks = [];
    archivedBookmarks = [];

    // Don't show the Bookmarks Bar name in front of titles
    const barTitles = new Set(topLevelFolders.filter(isBookmarksBar).map(node => node.title));

    // Traverse the bookmarks tree. The path is the list of folder titles starting from the top-level folder
    function traverseBookmarks(node, path, list) {
        if (node.url) {
            const displayPath = barTitles.has(path[0]) ? path.slice(1) : path;
            list.push({
                id: node.id,
                url: node.url,
                title: node.title,
                displayTitle: [...displayPath, node.title].join(' / '),
                path: path,
                unmodifiable: node.unmodifiable,
            });
        }
        if (node.children) {
            node.children.forEach(function(child) {
                traverseBookmarks(child, [...path, node.title], list);
            });
        }
    }

    topLevelFolders.forEach(function(top) {
        (top.children || []).forEach(function(child) {
            if (isArchiveFolder(child)) {
                // Folders inside the archive mirror the original path, so traverse them with an empty path
                (child.children || []).forEach(function(archived) {
                    traverseBookmarks(archived, [], archivedBookmarks);
                });
            } else {
                traverseBookmarks(child, [top.title], bookmarks);
            }
        });
    });

    // Reverse the order so that the most recent bookmarks are first
    bookmarks.reverse();
    archivedBookmarks.reverse();
}


// Find or create the chain of folders with the given titles under parentId, returning the last folder's id
async function ensureFolderPath(parentId, titles) {
    for (const title of titles) {
        const children = await chrome.bookmarks.getChildren(parentId);
        let folder = children.find(child => !child.url && child.title === title);
        if (!folder) {
            folder = await chrome.bookmarks.create({ parentId: parentId, title: title });
        }
        parentId = folder.id;
    }
    return parentId;
}


// Remove the archive's mirror folders that are left empty, from folderId upward, stopping at the archive folder
async function removeEmptyFolders(folderId) {
    while (folderId) {
        const [folder] = await chrome.bookmarks.get(folderId);
        if (!folder.parentId || folder.parentId === '0' || isArchiveFolder(folder)) {
            return;
        }
        const children = await chrome.bookmarks.getChildren(folderId);
        if (children.length > 0) {
            return;
        }
        await chrome.bookmarks.remove(folderId);
        folderId = folder.parentId;
    }
}


// Move a bookmark into the archive, mirroring its original folder path
async function archiveBookmark(item) {
    const otherBookmarks = findOtherBookmarks();
    const archiveFolderId = await ensureFolderPath(otherBookmarks.id, [ARCHIVE_FOLDER_NAME]);
    const destinationId = await ensureFolderPath(archiveFolderId, item.path);
    await chrome.bookmarks.move(item.id, { parentId: destinationId });
}


// Move an archived bookmark back to its original folder, recreating the folder if needed
async function restoreBookmark(item) {
    // The first folder in the archived path is the original top-level folder
    const [topTitle, ...subfolders] = item.path;
    const matches = topLevelFolders.filter(node => node.title === topTitle);
    let top = matches.find(node => node.syncing) || matches[0];
    let titles = subfolders;
    if (!top) {
        // Unknown top-level folder (e.g. renamed by a Chrome update), so restore the full path under Other Bookmarks
        top = findOtherBookmarks();
        titles = item.path;
    }
    const destinationId = await ensureFolderPath(top.id, titles);
    const [node] = await chrome.bookmarks.get(item.id);
    await chrome.bookmarks.move(item.id, { parentId: destinationId });
    await removeEmptyFolders(node.parentId);
}


window.onload = function() {
    let currentResults = [];  // Keep track of the current results

    const searchBar = document.getElementById('customSearchBar');
    searchBar.focus();

    let lastSearchResults = null;  // Store the last search results
    let lastUrlResults = null;  // Store the last URL search results

    function runSearch() {
        const startTime = performance.now();

        const query = searchBar.value;
        const source = archiveMode ? archivedBookmarks : bookmarks;

        if (query === '') {
            // If the search bar is empty, display all items
            lastSearchResults = null;
            lastUrlResults = null;
            currentResults = source;
        } else {
            let titleQuery, urlQuery;

            // Check if query contains double space for dual search
            if (query.includes('  ')) {
                const parts = query.split('  ');
                titleQuery = parts[0];
                urlQuery = parts[1] || '';
            } else {
                titleQuery = query;
                urlQuery = '';
            }

            let filteredBookmarks = source;

            let urlResults = null;

            // If URL query is provided, first filter by URL using fuzzysort
            if (urlQuery) {
                urlResults = fuzzysort.go(urlQuery, source, { key: 'url', threshold: FUZZYSORT_THRESHOLD });
                filteredBookmarks = urlResults.map(result => result.obj);
            }

            // Then search by title using fuzzysort
            if (titleQuery) {
                // NOTE: This fuzzysort is a little weird, displaying items that don't have the query contingous before ones that do
                const results = fuzzysort.go(titleQuery, filteredBookmarks, { key: 'displayTitle', limit: DISPLAY_LIMIT, threshold: FUZZYSORT_THRESHOLD });
                lastSearchResults = results;
                lastUrlResults = urlResults;
                currentResults = results.map(result => result.obj);
            } else {
                // If only URL filtering (no title query), display filtered results without fuzzysort
                lastSearchResults = null;
                lastUrlResults = urlResults;
                currentResults = filteredBookmarks;
            }
        }

        // Keep the selection in range, e.g. after the selected bookmark was archived
        selectedIndex = Math.max(0, Math.min(selectedIndex, currentResults.length - 1));
        displayItems(currentResults, lastSearchResults, lastUrlResults);

        const timeTaken = ((performance.now() - startTime) / 1000).toFixed(2);  // Time taken in seconds
        updateResultsInfo(currentResults, timeTaken);
    }

    function toggleArchiveMode() {
        archiveMode = !archiveMode;
        document.getElementById('title').textContent = archiveMode ? 'bookmark fzf / archive' : 'bookmark fzf';
        searchBar.placeholder = archiveMode ? 'Search archive...' : 'Search bookmarks...';
        selectedIndex = 0;
        runSearch();
        searchBar.focus();
    }

    // Archive the selected bookmark, or restore it when viewing the archive
    async function toggleArchived(item) {
        if (busy) {
            return;
        }
        if (item.unmodifiable) {
            showStatus("can't move a managed bookmark");
            return;
        }
        busy = true;
        try {
            if (archiveMode) {
                await restoreBookmark(item);
                showStatus(`restored: ${item.title}`);
            } else {
                await archiveBookmark(item);
                showStatus(`archived: ${item.title}`);
            }
        } catch (err) {
            showStatus(`couldn't ${archiveMode ? 'restore' : 'archive'}: ${err.message}`);
        }
        try {
            await loadBookmarks();
            runSearch();
        } finally {
            busy = false;
        }
    }

    // Get all bookmarks when the page loads
    loadBookmarks().then(runSearch);

    searchBar.addEventListener('input', function() {
        selectedIndex = 0;  // Reset the selected index
        runSearch();
    });

    document.getElementById('randomBookmarkText').addEventListener('click', function() {
        if (currentResults.length > 0) {
            const bookmark = currentResults[Math.floor(Math.random() * currentResults.length)];
            this.href = bookmark.url;
        }
    });

    document.getElementById('archiveToggleText').addEventListener('click', toggleArchiveMode);

    searchBar.addEventListener('keydown', function(e) {
        if ((e.ctrlKey && e.key === 'j') || e.key === 'ArrowDown') {
            // If Ctrl-j or ArrowDown is pressed, move the selection down
            e.preventDefault();  // Prevent the default behavior (scrolling the page)
            if (selectedIndex < currentResults.length - 1) {
                selectedIndex++;
                displayItems(currentResults, lastSearchResults, lastUrlResults);
            }
        } else if ((e.ctrlKey && e.key === 'k') || e.key === 'ArrowUp') {
            // If Ctrl-k or ArrowUp is pressed, move the selection up
            e.preventDefault();  // Prevent the default behavior (scrolling the page)
            if (selectedIndex > 0) {
                selectedIndex--;
                displayItems(currentResults, lastSearchResults, lastUrlResults);
            }
        } else if (e.ctrlKey && e.key === 'd') {
            selectedIndex += SCROLL_AMOUNT;
            if (selectedIndex > currentResults.length - 1) {
                selectedIndex = currentResults.length - 1;
            }
            displayItems(currentResults, lastSearchResults);
        } else if (e.ctrlKey && e.key === 'u') {
            selectedIndex -= SCROLL_AMOUNT;
            if (selectedIndex < 0) {
                selectedIndex = 0;
            }
            displayItems(currentResults, lastSearchResults);
        } else if (e.ctrlKey && e.key === 'x') {
            // If Ctrl-x is pressed, archive the selected bookmark (or restore it in the archive view)
            e.preventDefault();  // Prevent the default behavior (cutting text)
            if (currentResults.length > 0) {
                toggleArchived(currentResults[selectedIndex]);
            }
        } else if (e.ctrlKey && e.key === 'e') {
            // If Ctrl-e is pressed, switch between the bookmarks and the archive
            e.preventDefault();
            toggleArchiveMode();
        } else if (((e.ctrlKey && e.key === 'y') || e.key === "Enter") && currentResults.length > 0) {
            window.open(currentResults[selectedIndex].url, "_self");

            // TODO: Option for opening in a new tab (not sure if this is possible)
            // const newTab = window.open(currentResults[selectedIndex].url, '_blank');
            // window.focus();  // Try to refocus on the current window
        } else if (e.ctrlKey && e.key === 'r' && currentResults.length > 0) {
            const bookmark = currentResults[Math.floor(Math.random() * currentResults.length)];
            window.open(bookmark.url, "_self");
        }
    });
}
