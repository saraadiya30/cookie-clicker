Game.registerMod("cookie-bot-auto", {
    init: function() {
        if (window.autoCookieInterval) clearInterval(window.autoCookieInterval);

        let lastEl = null;
        const MILESTONES = [1, 10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600];

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

        function getItemData(item, isUpgrade) {
            let cost = item.getPrice();
            let deltaCps = 0;
            let globalMult = Game.globalCpsMult || 1;

            if (isUpgrade) {
                if (item.buildingTie) {
                    // Menghitung penambahan CPS jika upgrade melipatgandakan bangunan tertentu
                    let b = item.buildingTie;
                    deltaCps = (b.storedCps || 0) * b.amount * globalMult;
                } else if (item.power) {
                    deltaCps = (Game.cookiesPsRaw * (item.power / 100)) || 1;
                } else {
                    deltaCps = (Game.cookiesPsRaw * 0.01) || 1;
                }
            } else {
                deltaCps = (item.storedCps || (item.cps(item.amount + 1) - item.cps(item.amount))) * globalMult;

                // Logika Bonus Milestone
                let nextMilestone = MILESTONES.find(m => m > item.amount);
                if (nextMilestone) {
                    let distance = nextMilestone - item.amount;
                    if (distance <= 5) {
                        let bonusFactor = 1 + ((6 - distance) * 0.5);
                        deltaCps *= bonusFactor;
                    }
                }
            }

            return { item, cost, deltaCps: Math.max(0.0001, deltaCps), isUpgrade };
        }

        window.autoCookieInterval = setInterval(function() {
            let cookies = Game.cookies;
            let cpsRaw = Game.cookiesPsRaw || Game.cookiesPs || 1;

            // 1. Klik Big Cookie & Shimmers
            Game.ClickCookie();
            if (Game.shimmers && Game.shimmers.length > 0) {
                for (let i = Game.shimmers.length - 1; i >= 0; i--) {
                    if (Game.shimmers[i] && Game.shimmers[i].pop) {
                        Game.shimmers[i].pop();
                    }
                }
            }

            // 2. Sugar Lump
            if (Game.lumpT) {
                let age = Date.now() - Game.lumpT;
                if (age >= Game.lumpRipe && !Game.lumpClicking) {
                    Game.lumpClick();
                }
            }

            // 3. Elder Pledge
            let pledge = Game.UpgradesById && Game.UpgradesById[74];
            if (pledge && pledge.unlocked && !pledge.bought && Game.UpgradesInStore.includes(pledge)) {
                if (cookies >= pledge.getPrice()) pledge.buy();
            }

            // 4. Kumpulkan Opsi Bangunan & Upgrade
            let candidates = [];
            for (let obj of Game.ObjectsById) {
                if (obj) candidates.push(getItemData(obj, false));
            }
            for (let up of Game.UpgradesInStore) {
                if (up && up.pool !== 'toggle' && up.name !== 'Elder Covenant') {
                    candidates.push(getItemData(up, true));
                }
            }

            // 5. Cari Target Utama (PP Terbaik)
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

            // 6. Logika Stepping-Stone
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

            // 7. Bank Buffer
            let bankBuffer = 0;
            if (Game.Has('Get lucky')) {
                bankBuffer = cpsRaw * 42000;
            } else if (Game.Has('Lucky day')) {
                bankBuffer = cpsRaw * 6000;
            }

            // 8. Eksekusi Pembelian & Highlight
            clear();
            let targetObj = finalAction.item;
            let el = findEl(targetObj, finalAction.isUpgrade);

            if (el) {
                el.style.outline = '3px solid #00ff00';
                el.style.backgroundColor = 'rgba(0, 255, 0, 0.2)';
                lastEl = el;
            }

            let effectiveCookies = cookies - bankBuffer;

            if (cookies >= finalAction.cost) {
                if (effectiveCookies >= finalAction.cost || cookies < bankBuffer * 0.3) {
                    if (finalAction.isUpgrade) {
                        finalAction.item.buy();
                    } else {
                        finalAction.item.buy(1);
                    }
                    clear();
                }
            }

        }, 200);

        Game.Notify('Cookie Bot', 'Bot aktif & memperhitungkan Store!', [16, 5]);
    }
});
