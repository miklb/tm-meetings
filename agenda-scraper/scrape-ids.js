const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');

async function scrapeMeetingIds(url) {
    // Set up the Selenium WebDriver
    let driver = await new Builder().forBrowser('chrome').build();
    
    try {
        // Load the page
        await driver.get(url);
        
        // Wait for the #meetings-list-upcoming element to be loaded
        await driver.wait(until.elementLocated(By.id('meetings-list-upcoming')), 10000);
        
        // Extract the page source
        let pageSource = await driver.getPageSource();
        
        // Load the page source into cheerio
        const $ = cheerio.load(pageSource);
        
        // Find all unique data-meeting-id attributes in the #meetings-list-upcoming element
        let meetingIds = new Set();
        $('#meetings-list-upcoming [data-meeting-id]').each((i, element) => {
            meetingIds.add($(element).attr('data-meeting-id'));
        });
        
        // Convert the set to an array and log the unique meeting IDs
        let uniqueMeetingIds = Array.from(meetingIds);
        
        return uniqueMeetingIds;
    } finally {
        // Quit the driver
        await driver.quit();
    }
}

// URL of the page to scrape
let url = 'https://tampagov.hylandcloud.com/221agendaonline/';

// Call the function
scrapeMeetingIds(url);