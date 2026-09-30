export default async function openPopup() {
    if (chrome.windows) {
        const url = 'popup.html';
        const w = await chrome.windows.create({
            url,
            type: "popup",
            // Use dimensions closer to a typical default popup size
            width: 400,
            height: 600
        });
        const tab = w.tabs?.[0];
        return tab?.id;
    }

    return null;
}