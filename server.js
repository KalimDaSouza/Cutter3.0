const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Parsuj input z formatem "długość x ilość" lub zwykłymi liczbami
function parseInput(input) {
    const cuts = [];
    const parts = input.split(',');
    
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        
        // Sprawdź format "długość x ilość"
        if (trimmed.includes('x') || trimmed.includes('X')) {
            const [lengthStr, quantityStr] = trimmed.split(/[xX]/).map(s => s.trim());
            const length = parseInt(lengthStr);
            const quantity = parseInt(quantityStr);
            
            if (!isNaN(length) && !isNaN(quantity) && length > 0 && quantity > 0) {
                for (let i = 0; i < quantity; i++) {
                    cuts.push(length);
                }
            }
        } else {
            // Zwykła liczba
            const length = parseInt(trimmed);
            if (!isNaN(length) && length > 0) {
                cuts.push(length);
            }
        }
    }
    
    return cuts;
}

// Algorytm optymalizacji - Best Fit Decreasing z look-ahead (ulepszona wersja)
function optimizeCuts(requiredCuts, stockLengths, kerf = 0) {
    // Sortuj cięcia malejąco
    const sortedCuts = [...requiredCuts].sort((a, b) => b - a);
    const result = [];

    // Zlicz ile jest identycznych długości (dla look-ahead)
    const cutCounts = {};
    sortedCuts.forEach(cut => {
        cutCounts[cut] = (cutCounts[cut] || 0) + 1;
    });

    // Oblicz zajętą długość z uwzględnieniem kerf (naddatek między cięciami)
    function usedWithKerf(cuts) {
        if (cuts.length === 0) return 0;
        return cuts.reduce((sum, c) => sum + c, 0) + (cuts.length - 1) * kerf;
    }

    for (const cut of sortedCuts) {
        let placed = false;
        let bestPlanIndex = -1;
        let bestWaste = Infinity;

        // Znajdź najlepsze dopasowanie w istniejących sztangach
        for (let i = 0; i < result.length; i++) {
            const plan = result[i];
            const remaining = plan.stockLength - usedWithKerf(plan.cuts);

            if (remaining >= cut + kerf) {
                const wasteAfter = remaining - cut - kerf;
                if (wasteAfter < bestWaste) {
                    bestWaste = wasteAfter;
                    bestPlanIndex = i;
                }
            }
        }

        if (bestPlanIndex !== -1) {
            result[bestPlanIndex].cuts.push(cut);
            placed = true;
            cutCounts[cut]--;
        }

        // Użyj nowej sztangi - wybierz optymalną długość z look-ahead
        if (!placed) {
            const suitableStocks = stockLengths.filter(s => s >= cut);

            if (suitableStocks.length === 0) {
                throw new Error(`Brak ksztalownika o dlugosci >= ${cut} mm`);
            }

            let bestStock = suitableStocks[0];
            let bestScore = -1;

            // Dla każdej możliwej długości sztangi oblicz "score"
            for (const stock of suitableStocks) {
                // Sprawdź ile takich samych cięć zmieści się na tej sztandze (kerf między cięciami)
                const fitsCount = Math.floor((stock + kerf) / (cut + kerf));
                const remainingOfThisCut = cutCounts[cut] || 0;
                const willUse = Math.min(fitsCount, remainingOfThisCut);

                if (willUse === 0) continue;

                // Score: im więcej zmieści, tym lepiej
                const totalUsed = willUse * cut + (willUse - 1) * kerf;
                const waste = stock - totalUsed;
                const wastePerCut = waste / willUse;

                // Score: liczba cięć * 10000 - strata na cięcie (preferuj więcej cięć, potem mniejszą stratę)
                const score = willUse * 10000 - wastePerCut;

                if (score > bestScore) {
                    bestScore = score;
                    bestStock = stock;
                }
            }

            result.push({
                stockLength: bestStock,
                cuts: [cut]
            });

            cutCounts[cut]--;
            placed = true;
        }
    }

    // Dodaj obliczenia waste (z kerf)
    return result.map(plan => ({
        ...plan,
        waste: plan.stockLength - usedWithKerf(plan.cuts)
    }));
}

// Oblicz podsumowanie
function calculateSummary(plans) {
    const totalStockUsed = plans.length;
    const totalLength = plans.reduce((sum, p) => sum + p.stockLength, 0);
    const totalWaste = plans.reduce((sum, p) => sum + p.waste, 0);
    const totalUsed = totalLength - totalWaste;
    const efficiency = totalLength > 0 ? ((totalUsed / totalLength) * 100).toFixed(2) : 0;
    
    // Zlicz użycie każdej długości sztangi
    const stockUsage = {};
    plans.forEach(plan => {
        const length = plan.stockLength;
        if (!stockUsage[length]) {
            stockUsage[length] = { count: 0, totalWaste: 0 };
        }
        stockUsage[length].count++;
        stockUsage[length].totalWaste += plan.waste;
    });
    
    // Sortuj według długości malejąco
    const sortedStockUsage = Object.entries(stockUsage)
        .sort(([a], [b]) => parseInt(b) - parseInt(a))
        .map(([length, data]) => ({
            length: parseInt(length),
            count: data.count,
            totalWaste: data.totalWaste
        }));
    
    // Generuj tekst podsumowania użycia sztang
    const stockUsageText = sortedStockUsage
        .map(item => `${item.count}x ${item.length}mm (strata: ${item.totalWaste}mm)`)
        .join(', ');
    
    return {
        totalStockUsed,
        totalLength,
        totalWaste,
        totalUsed,
        efficiency,
        stockUsage: sortedStockUsage,
        summary: `Uzyto sztang: ${totalStockUsed} | Laczna dlugosc: ${totalLength} mm | Calkowita strata: ${totalWaste} mm | Efektywnosc: ${efficiency}%`,
        stockUsageSummary: `Uzycie sztang: ${stockUsageText}`
    };
}

// API Endpoints

// POST /api/optimize - Optymalizacja cięcia
app.post('/api/optimize', (req, res) => {
    try {
        let { requiredCuts, stockLengths, cutsInput, kerf, contractNumber, profileType } = req.body;

        const kerfValue = parseFloat(kerf) || 0;

        // Jeśli przyszedł cutsInput (string), sparsuj go
        if (cutsInput && typeof cutsInput === 'string') {
            requiredCuts = parseInput(cutsInput);
        }

        if (!requiredCuts || !Array.isArray(requiredCuts) || requiredCuts.length === 0) {
            return res.status(400).json({ error: 'Brak wymaganych dlugosci ciec' });
        }

        if (!stockLengths || !Array.isArray(stockLengths) || stockLengths.length === 0) {
            return res.status(400).json({ error: 'Brak dostepnych dlugosci sztang' });
        }

        const plans = optimizeCuts(requiredCuts, stockLengths, kerfValue);
        const summary = calculateSummary(plans);

        res.json({
            plans,
            ...summary,
            contractNumber: contractNumber || '',
            profileType: profileType || '',
            kerf: kerfValue
        });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Etykiety eksportu wg języka
function exportLabels(lang) {
    if (lang === 'en') return { title: 'Cutting List', contract: 'Contract', profile: 'Profile' };
    return { title: 'Lista Ciec', contract: 'Kontrakt', profile: 'Profil' };
}

// POST /api/export/pdf - Eksport do PDF
app.post('/api/export/pdf', (req, res) => {
    try {
        const { plans, contractNumber, profileType, lang } = req.body;
        const lbl = exportLabels(lang);

        const doc = new PDFDocument();

        // Buduj nazwę pliku z kontraktu i profilu
        let filename = 'wycinacz';
        if (contractNumber) filename += `_${contractNumber}`;
        if (profileType) filename += `_${profileType}`;
        filename += '.pdf';
        // Usuń znaki niedozwolone w nazwie pliku
        filename = filename.replace(/[^a-zA-Z0-9._\-]/g, '_');

        // Ustaw nagłówki
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

        // Pipe PDF do response
        doc.pipe(res);

        // Tytul
        let title = lbl.title;
        if (contractNumber) title += ` | ${lbl.contract}: ${contractNumber}`;
        if (profileType) title += ` | ${lbl.profile}: ${profileType}`;
        doc.fontSize(16).text(title, { underline: true });
        doc.moveDown();

        // Tylko podział - bez statystyk waste/efficiency
        plans.forEach((plan, index) => {
            doc.fontSize(12).text(
                `${plan.stockLength} mm => ${plan.cuts.join(', ')} mm`
            );
            doc.moveDown(0.3);
        });

        // Zakończ dokument
        doc.end();

    } catch (error) {
        res.status(500).json({ error: 'Blad generowania PDF' });
    }
});

// POST /api/export/txt - Eksport do TXT
app.post('/api/export/txt', (req, res) => {
    try {
        const { plans, contractNumber, profileType, lang } = req.body;
        const lbl = exportLabels(lang);

        // Buduj nazwę pliku z kontraktu i profilu
        let filename = 'wycinacz';
        if (contractNumber) filename += `_${contractNumber}`;
        if (profileType) filename += `_${profileType}`;
        filename += '.txt';
        filename = filename.replace(/[^a-zA-Z0-9._\-]/g, '_');

        let title = lbl.title;
        if (contractNumber) title += ` | ${lbl.contract}: ${contractNumber}`;
        if (profileType) title += ` | ${lbl.profile}: ${profileType}`;

        let text = title + '\n';
        text += '='.repeat(title.length) + '\n\n';

        // Tylko podział - bez statystyk waste/efficiency
        plans.forEach((plan, index) => {
            text += `${plan.stockLength} mm => ${plan.cuts.join(', ')} mm\n`;
        });

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.send(text);

    } catch (error) {
        res.status(500).json({ error: 'Blad generowania TXT' });
    }
});

// GET / - Strona główna
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Start serwera
app.listen(PORT, () => {
    console.log(`🔧 Wycinacz uruchomiony na porcie ${PORT}`);
    console.log(`📍 http://localhost:${PORT}`);
});
