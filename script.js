Game.registerMod("cookie-bot-auto", {
    init: function() {
        if (window.autoCookieClickInterval) clearInterval(window.autoCookieClickInterval);
        if (window.autoCookieBuyInterval) clearInterval(window.autoCookieBuyInterval);

        let lastEl = null;
        const MILESTONES = [1, 10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600];

        // cache 'Get lucky' / 'Lucky day' biar gak query Game.Has tiap tick
        let hasLucky = { getLucky: false, luckyDay: false };
        function refreshLuckyCache() {
            hasLucky.getLucky = Game.Has('Get lucky');
            hasLucky.luckyDay = Game.Has('Lucky day');
        }
        refreshLuckyCache();

        function clear() {
            if (lastEl) {
                lastEl.style.outline = '';
                lastEl.style.backgroundColor = '';
                lastEl = null;
            }
        }

        function findEl(item, isUpgrade) {
            if (!item) return null;
            if (isUpgrade) {
                let index = Game.UpgradesInStore.indexOf(item);
                return index !== -1 ? document.getElementById('upgrade' + index) : null;
            }
            return document.getElementById('product' + item.id);
        }

        // return null kalau upgrade gak jelas efeknya ke CPS -> di-skip dari kandidat
        function getItemData(item, isUpgrade) {
            let cost = 0;
            try {
                cost = typeof item.getPrice === 'function' ? item.getPrice() : (item.price || 0);
            } catch (e) {
                cost = 0;
            }

            let deltaCps = 0;

            if (isUpgrade) {
                try {
                    if (item.buildingTie) {
                        let b = item.buildingTie;
                        let bCps = (typeof b.cps === 'function') ? b.cps(b) : 0;
                        deltaCps = bCps * b.amount;
                    } else if (item.power) {
                        deltaCps = Game.cookiesPsRaw * (item.power / 100);
                    } else {
                        // efek ke CPS gak diketahui -> jangan dipaksa masuk sistem payback
                        return null;
                    }
                } catch (e) {
                    return null;
                }
            } else {
                try {
                    deltaCps = (typeof item.cps === 'function') ? item.cps(item) : 0;

                    let nextMilestone = MILESTONES.find(m => m > item.amount);
                    if (nextMilestone) {
                        let distance = nextMilestone - item.amount;
                        if (distance <= 5) {
                            let bonusFactor = 1 + ((6 - distance) * 0.5);
                            deltaCps *= bonusFactor;
                        }
                    }
                } catch (e) {
                    deltaCps = 0;
                }
            }

            if (isNaN(deltaCps) || deltaCps <= 0) {
                deltaCps = 0.0001;
            }

            return { item, cost, deltaCps, isUpgrade };
        }

        // cast Force the Hand of Fate begitu mana penuh, langsung sikat golden cookie yang muncul
        function tryCastForceHand() {
            let wizardTower = Game.ObjectsById[7];
            if (!wizardTower || !wizardTower.minigame) {
                console.log('[CookieBot] Grimoire belum unlock atau Wizard Tower belum level 1');
                return;
            }
        
            let grimoire = wizardTower.minigame;
            let spell = grimoire.spells['hand of fate'];
            if (!spell) {
                console.log('[CookieBot] Spell "hand of fate" gak ketemu di grimoire.spells:', Object.keys(grimoire.spells));
                return;
            }
        
            let cost = spell.costMin + grimoire.magicM * spell.costPercent;
            console.log('[CookieBot] magic:', grimoire.magic, '/ magicM:', grimoire.magicM, '/ cost:', cost);
        
            if (grimoire.magic >= grimoire.magicM && grimoire.magic >= cost) {
                grimoire.castSpell(spell);
                Game.Notify('Cookie Bot', 'Force the Hand of Fate dicast!', [16, 5]);
                
                if (Game.shimmers && Game.shimmers.length > 0) {
                    for (let i = Game.shimmers.length - 1; i >= 0; i--) {
                        if (Game.shimmers[i] && Game.shimmers[i].pop) {
                            Game.shimmers[i].pop();
                        }
                    }
                }
            } else {
                console.log('[CookieBot] Syarat belum kepenuhi, skip cast tick ini');
            }
        }

        // === LOOP CEPAT: klik cookie + shimmer + sugar lump (respons tinggi) ===
        window.autoCookieClickInterval = setInterval(function() {
            Game.ClickCookie();

            if (Game.shimmers && Game.shimmers.length > 0) {
                for (let i = Game.shimmers.length - 1; i >= 0; i--) {
                    if (Game.shimmers[i] && Game.shimmers[i].pop) {
                        Game.shimmers[i].pop();
                    }
                }
            }

            if (Game.lumpT) {
                let age = Date.now() - Game.lumpT;
                if (age >= Game.lumpRipe && !Game.lumpClicking) {
                    Game.lumpClick();
                }
            }
        }, 100);

        // === LOOP LAMBAT: keputusan beli & spell (harga/CPS/mana gak berubah secepat itu) ===
        window.autoCookieBuyInterval = setInterval(function() {
            let cookies = Game.cookies;
            let cpsRaw = Game.cookiesPsRaw || Game.cookiesPs || 1;

            tryCastForceHand();

            // Elder Pledge: beli langsung kalau affordable
            let pledge = Game.UpgradesById && Game.UpgradesById[74];
            if (pledge && pledge.unlocked && !pledge.bought && Game.UpgradesInStore.includes(pledge)) {
                if (cookies >= pledge.getPrice()) pledge.buy();
            }

            // Kumpulkan kandidat (skip null = upgrade non-CPS yang gak jelas efeknya)
            let candidates = [];
            for (let obj of Game.ObjectsById) {
                if (obj) {
                    let d = getItemData(obj, false);
                    if (d) candidates.push(d);
                }
            }
            for (let up of Game.UpgradesInStore) {
                if (up && up.pool !== 'toggle' && up.name !== 'Elder Covenant') {
                    let d = getItemData(up, true);
                    if (d) candidates.push(d);
                }
            }

            if (candidates.length === 0) return;

            // Cari target utama (payback period terbaik)
            let bestTarget = null;
            let minPP = Infinity;

            for (let cand of candidates) {
                let timeToSave = Math.max(0, cand.cost - cookies) / cpsRaw;
                let payback = cand.cost / cand.deltaCps;
                let pp = timeToSave + payback;

                if (pp < minPP) {
                    minPP = pp;
                    bestTarget = cand;
                }
            }

            if (!bestTarget) return;

            // Logika stepping-stone
            let finalAction = bestTarget;
            let timeDirect = Math.max(0, bestTarget.cost - cookies) / cpsRaw;
            let bestTimeSaved = 0;

            for (let cand of candidates) {
                if (cand.item === bestTarget.item) continue;
                if (cand.cost >= bestTarget.cost) continue;

                let timeS = Math.max(0, cand.cost - cookies) / cpsRaw;
                if (timeS >= timeDirect) continue;

                let newCps = cpsRaw + cand.deltaCps;
                let cookiesAfterS = Math.max(0, cookies + (timeS * cpsRaw) - cand.cost);
                let timeTargetAfterS = Math.max(0, bestTarget.cost - cookiesAfterS) / newCps;

                let totalTimeWithS = timeS + timeTargetAfterS;
                let timeSaved = timeDirect - totalTimeWithS;

                if (timeSaved > bestTimeSaved) {
                    bestTimeSaved = timeSaved;
                    finalAction = cand;
                }
            }

            // Bank buffer (pakai cache, bukan query tiap tick)
            let bankBuffer = 0;
            if (hasLucky.getLucky) {
                bankBuffer = cpsRaw * 42000;
            } else if (hasLucky.luckyDay) {
                bankBuffer = cpsRaw * 6000;
            }

            // Highlight (cuma di-rewrite kalau target beda dari tick sebelumnya)
            let targetObj = finalAction.item;
            let el = findEl(targetObj, finalAction.isUpgrade);

            if (el !== lastEl) {
                clear();
                if (el) {
                    el.style.outline = '3px solid #00ff00';
                    el.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
                    lastEl = el;
                }
            }

            // Eksekusi beli
            let effectiveCookies = cookies - bankBuffer;

            if (cookies >= finalAction.cost) {
                if (effectiveCookies >= finalAction.cost || cookies < bankBuffer * 0.3) {
                    if (finalAction.isUpgrade) {
                        finalAction.item.buy();
                    } else {
                        finalAction.item.buy(1);
                    }
                    refreshLuckyCache();
                    clear();
                }
            }
        }, 750);

        Game.Notify('Cookie Bot', 'Bot aktif & siap jalan!', [16, 5]);
    }
});
