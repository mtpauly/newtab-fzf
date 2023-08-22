var selectedIndex = 0;  // keep track of the selected index


function displayItems(items, results) {
    // clear the previous results
    var resultsDiv = document.getElementById('results');
    while (resultsDiv.firstChild) {
        resultsDiv.removeChild(resultsDiv.firstChild);
    }

    // if there are no results, display a message
    if (items.length === 0) {
        var div = document.createElement('div');
        div.textContent = "No results found.";
        resultsDiv.appendChild(div);
        return;
    }

    // display the new results
    items.forEach(function(item, i) {
        var div = document.createElement('div');
        var a = document.createElement('a');
        var favicon = `<img src="https://www.google.com/s2/favicons?domain=${item.url}" class="favicon">`
        var url_text = `&nbsp;&nbsp;&nbsp;&nbsp;<span class="url">${item.url}</span>`;
        if (results) {
            // if search results are provided, highlight the matched characters
            var highlight = fuzzysort.highlight(results[i], '<span class="highlight">', '</span>')
            div.innerHTML = favicon + `<span class="text">${highlight}${url_text}</span>`;
        } else {
            // if no search results are provided, display the title as is
            div.innerHTML = favicon + `<span class="text">${item.title}${url_text}</span>`;
        }
        a.href = item.url;
        a.target = "_blank";  // open in a new tab
        a.appendChild(div);
        if (i === selectedIndex) {
            // if this is the selected item, add the selected class
            div.classList.add('selected');
        }
        resultsDiv.appendChild(a);
    });
}


window.onload = function() {
    let bookmarks = [];
    var currentResults = [];  // keep track of the current results

    // Get all bookmarks when the page loads
    chrome.bookmarks.getTree(function(nodes) {
        nodes.forEach(function(node) {
            traverseBookmarks(node, "");
        });

        displayItems(bookmarks);  // display all items initially
        currentResults = bookmarks;
    });

    // Traverse the bookmarks tree
    function traverseBookmarks(node, folder) {
        folder = folder.replace("/ Bookmarks Bar /", "")
        if(node.url) {
            node.title = folder + node.title
            bookmarks.push(node);
        }
        if(node.children) {
            node.children.forEach(function(child) {
                traverseBookmarks(child, folder + node.title + " / ");
            });
        }
    }

    var searchBar = document.getElementById('customSearchBar');
    searchBar.focus();

    var lastSearchResults = null;  // store the last search results
    searchBar.addEventListener('input', function() {
        var query = this.value;
        selectedIndex = 0;  // reset the selected index
        
        if (query === '') {
            // if the search bar is empty, display all items
            displayItems(bookmarks);
            lastSearchResults = null;
            currentResults = bookmarks;
        } else {
            // TODO: this fuzzysort is a little weird, displaying items that don't have the query contingous before ones that do
            var results = fuzzysort.go(query, bookmarks, {key: 'title', limit: 50, threshold: 0});
            var results_obj = results.map(result => result.obj)
            displayItems(results_obj, results);
            lastSearchResults = results;
            currentResults = results_obj;
        }
    });

    searchBar.addEventListener('keydown', function(e) {
        if ((e.ctrlKey && e.key === 'j') || e.key === 'ArrowDown') {
            // if Ctrl-j or ArrowDown is pressed, move the selection down
            e.preventDefault();  // prevent the default behavior (scrolling the page)
            if (selectedIndex < currentResults.length - 1) {
                selectedIndex++;
                displayItems(currentResults, lastSearchResults);
            }
        } else if ((e.ctrlKey && e.key === 'k') || e.key === 'ArrowUp') {
            // if Ctrl-k or ArrowUp is pressed, move the selection up
            e.preventDefault();  // prevent the default behavior (scrolling the page)
            if (selectedIndex > 0) {
                selectedIndex--;
                displayItems(currentResults, lastSearchResults);
            }
        } else if (((e.ctrlKey && e.key === 'y') || e.key === "Enter") && currentResults.length > 0) {
            window.open(currentResults[selectedIndex].url, "_self");
            // TODO: option for opening in a new tab
            // var newTab = window.open(currentResults[selectedIndex].url, '_blank');
            // window.focus();  // try to refocus on the current window
        }});
}
