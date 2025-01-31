window.addEventListener("message", (event) => {
    // Ensure the message comes from your website
    if (event.origin !== "https://purevanilla.co") return;
    if (event.data.type !== 'FROM_PAGE') return;

    // Forward the message to the background script
    chrome.runtime.sendMessage(event.data);
});
