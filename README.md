=== BOSS IMAGE SETUP ===

Place your PNG images in THIS folder (docs/images/) with these EXACT names:

  Boss.png        - The main boss asteroid (appears every 10 waves)
  boss-ad-1.png   - Boss minion variant 1
  boss-ad-2.png   - Boss minion variant 2  
  boss-ad-3.png   - Boss minion variant 3
  boss-ad-4.png   - Boss minion variant 4
  boss-ad-5.png   - Boss minion variant 5

IMPORTANT: 
- File names are CASE SENSITIVE (Boss.png not boss.png)
- Files must be PNG format
- The game will show console messages indicating which images loaded/failed
- If images fail to load, the game falls back to procedural asteroid rendering

File structure should look like:
  rogue-asteroid-pvp/
  ├── server.js
  ├── package.json
  └── docs/
      ├── index.html
      ├── client.js
      ├── style.css
      └── images/          <-- YOUR IMAGES GO HERE
          ├── Boss.png
          ├── boss-ad-1.png
          ├── boss-ad-2.png
          ├── boss-ad-3.png
          ├── boss-ad-4.png
          └── boss-ad-5.png