const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Generuj unikalny numer zamówienia
function generateOrderNumber() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `WYC-${year}${month}${day}-${random}`;
}

// Parsuj input z formatem "długość x ilość" lub zwykłymi liczbami
function parseInput(input) {
    const cuts = [];
    const parts = input.split(',');

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

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
            const length = parseInt(trimmed);
            if (!isNaN(length) && length > 0) {
                cuts.push(length);
            }
        }
    }

    return cuts;
}

// Algorytm optymalizacji - Best Fit Decreasing z look-ahead + KERF
function optimizeCuts(requiredCuts, stockLengths, kerf = 0) {
    const sortedCuts = [...requiredCuts].sort((a, b) => b - a);
    const result = [];

    const cutCounts = {};
    sortedCuts.forEach(cut => {
        cutCounts[cut] = (cutCounts[cut] || 0) + 1;
    });

    for (const cut of sortedCuts) {
        let placed = false;
        let bestPlanIndex = -1;
        let bestWaste = Infinity;

        for (let i = 0; i < result.length; i++) {
            const plan = result[i];
            const usedLength = plan.cuts.reduce((sum, c) => sum + c, 0) + (plan.cuts.length * kerf);
            const remaining = plan.stockLength - usedLength;

            const neededSpace = cut + (plan.cuts.length > 0 ? kerf : 0);

            if (remaining >= neededSpace) {
                const wasteAfter = remaining - neededSpace;
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

        if (!placed) {
            const suitableStocks = stockLengths.filter(s => s >= cut);
            if (suitableStocks.length === 0) {
                throw new Error(`Brak ksztalownika o dlugosci >= ${cut} mm`);
            }

            let bestStock = suitableStocks[0];
            let bestScore = -1;

            for (const stock of suitableStocks) {
                const fitsCount = Math.floor(stock / (cut + kerf));
                const remainingOfThisCut = cutCounts[cut] || 0;
                const willUse = Math.min(fitsCount, remainingOfThisCut);

                const totalUsed = willUse * (cut + kerf) - kerf;
                const waste = stock - totalUsed;
                const wastePerCut = willUse > 0 ? waste / willUse : stock;

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

    return result.map(plan => {
        const usedLength = plan.cuts.reduce((sum, c) => sum + c, 0);
        const kerfLoss = plan.cuts.length > 0 ? (plan.cuts.length - 1) * kerf : 0;
        const totalUsed = usedLength + kerfLoss;

        return {
            ...plan,
            usedLength: totalUsed,
            kerfLoss: kerfLoss,
            waste: plan.stockLength - totalUsed
        };
    });
}

// Oblicz podsumowanie
function calculateSummary(plans, kerf = 0) {
    const totalStockUsed = plans.length;
    const totalLength = plans.reduce((sum, p) => sum + p.stockLength, 0);
    const totalWaste = plans.reduce((sum, p) => sum + p.waste, 0);
    const totalKerfLoss = plans.reduce((sum, p) => sum + (p.kerfLoss || 0), 0);
    const totalUsed = totalLength - totalWaste;
    const efficiency = totalLength > 0 ? ((totalUsed / totalLength) * 100).toFixed(2) : 0;

    const stockUsage = {};
    plans.forEach(plan => {
        const length = plan.stockLength;
        if (!stockUsage[length]) {
            stockUsage[length] = { count: 0, totalWaste: 0 };
        }
        stockUsage[length].count++;
        stockUsage[length].totalWaste += plan.waste;
    });

    const sortedStockUsage = Object.entries(stockUsage)
        .sort(([a], [b]) => parseInt(b) - parseInt(a))
        .map(([length, data]) => ({
            length: parseInt(length),
            count: data.count,
            totalWaste: data.totalWaste
        }));

    const stockUsageText = sortedStockUsage
        .map(item => `${item.count}x ${item.length}mm (strata: ${item.totalWaste}mm)`)
        .join(', ');

    const kerfText = kerf > 0 ? ` | Strata na ciecie (kerf): ${totalKerfLoss}mm` : '';

    return {
        totalStockUsed,
        totalLength,
        totalWaste,
        totalKerfLoss,
        totalUsed,
        efficiency,
        stockUsage: sortedStockUsage,
        summary: `Uzyto sztang: ${totalStockUsed} | Laczna dlugosc: ${totalLength}mm | Calkowita strata: ${totalWaste}mm${kerfText} | Efektywnosc: ${efficiency}%`,
        stockUsageSummary: `Uzycie sztang: ${stockUsageText}`
    };
}

// API Endpoints

// POST /api/optimize - Optymalizacja cięcia
app.post('/api/optimize', (req, res) => {
    try {
        let { requiredCuts, stockLengths, cutsInput, kerf, orderNumber } = req.body;

        const kerfValue = kerf !== undefined ? parseFloat(kerf) : 0;

        if (isNaN(kerfValue) || kerfValue < 0) {
            return res.status(400).json({ error: 'Nieprawidlowa wartosc kerf' });
        }

        if (cutsInput && typeof cutsInput === 'string') {
            requiredCuts = parseInput(cutsInput);
        }

        if (!requiredCuts || !Array.isArray(requiredCuts) || requiredCuts.length === 0) {
            return res.status(400).json({ error: 'Brak wymaganych dlugosci ciec' });
        }

        if (!stockLengths || !Array.isArray(stockLengths) || stockLengths.length === 0) {
            return res.status(400).json({ error: 'Brak dostepnych dlugosci sztang' });
        }

        // Generuj numer zamówienia jeśli nie podano
        const finalOrderNumber = orderNumber || generateOrderNumber();
        const timestamp = new Date().toISOString();

        const plans = optimizeCuts(requiredCuts, stockLengths, kerfValue);
        const summary = calculateSummary(plans, kerfValue);

        res.json({
            plans,
            kerf: kerfValue,
            orderNumber: finalOrderNumber,
            timestamp,
            ...summary
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/export/excel - Eksport do Excel z QR kodami
app.post('/api/export/excel', async (req, res) => {
    try {
        const { plans, summary, stockUsageSummary, kerf, orderNumber, timestamp } = req.body;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Wycinacz Pro';
        workbook.created = new Date();

        const worksheet = workbook.addWorksheet('Plan Cięcia');

        // Nagłówek z danymi zamówienia
        worksheet.mergeCells('A1:F1');
        worksheet.getCell('A1').value = 'RAPORT OPTYMALIZACJI CIĘCIA';
        worksheet.getCell('A1').font = { bold: true, size: 16 };
        worksheet.getCell('A1').alignment = { horizontal: 'center' };

        worksheet.mergeCells('A2:F2');
        worksheet.getCell('A2').value = `Numer zamówienia: ${orderNumber || 'BRAK'}`;
        worksheet.getCell('A2').font = { bold: true, size: 12 };

        worksheet.mergeCells('A3:F3');
        const date = timestamp ? new Date(timestamp) : new Date();
        worksheet.getCell('A3').value = `Data: ${date.toLocaleString('pl-PL')}`;
        worksheet.getCell('A3').font = { size: 11 };

        if (kerf && kerf > 0) {
            worksheet.mergeCells('A4:F4');
            worksheet.getCell('A4').value = `Strata na cięciu (kerf): ${kerf} mm`;
            worksheet.getCell('A4').font = { italic: true, color: { argb: 'FFFF6600' } };
        }

        // Pusta linia
        worksheet.addRow([]);

        // Nagłówki tabeli
        const headerRow = worksheet.addRow([
            '# Sztangi',
            'Długość sztangi (mm)',
            'Cięcia (mm)',
            'Użyte (mm)',
            'Strata (mm)',
            'Kod QR'
        ]);

        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF667eea' }
        };
        headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

        // Dane dla każdej sztangi
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const usedLength = plan.cuts.reduce((sum, c) => sum + c, 0);
            const kerfLoss = plan.kerfLoss || 0;
            const totalUsed = usedLength + kerfLoss;

            // Generuj dane QR kodu
            const qrData = JSON.stringify({
                order: orderNumber || 'BRAK',
                bar: i + 1,
                length: plan.stockLength,
                cuts: plan.cuts,
                waste: plan.waste
            });

            // Generuj QR kod jako base64
            const qrCodeDataUrl = await QRCode.toDataURL(qrData, {
                width: 150,
                margin: 1
            });

            const row = worksheet.addRow([
                i + 1,
                plan.stockLength,
                plan.cuts.join(', '),
                `${usedLength}${kerfLoss > 0 ? ' + ' + kerfLoss : ''}`,
                plan.waste,
                '' // Tutaj będzie QR kod
            ]);

            // Dodaj QR kod jako obrazek
            const imageId = workbook.addImage({
                base64: qrCodeDataUrl,
                extension: 'png'
            });

            worksheet.addImage(imageId, {
                tl: { col: 5, row: row.number - 1 },
                ext: { width: 80, height: 80 }
            });

            // Zwiększ wysokość wiersza dla QR kodu
            row.height = 60;
            row.alignment = { vertical: 'middle' };
        }

        // Podsumowanie
        worksheet.addRow([]);
        const summaryRow = worksheet.addRow(['PODSUMOWANIE']);
        summaryRow.font = { bold: true, size: 12 };
        worksheet.mergeCells(`A${summaryRow.number}:F${summaryRow.number}`);

        worksheet.addRow(['Użyto sztang:', plans.length]);
        worksheet.addRow(['Całkowita strata:', `${plans.reduce((sum, p) => sum + p.waste, 0)} mm`]);
        if (kerf > 0) {
            worksheet.addRow(['Strata na kerf:', `${plans.reduce((sum, p) => sum + (p.kerfLoss || 0), 0)} mm`]);
        }

        // Formatowanie kolumn
        worksheet.columns = [
            { width: 12 },
            { width: 20 },
            { width: 35 },
            { width: 18 },
            { width: 15 },
            { width: 15 }
        ];

        // Ustaw border dla całej tabeli
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 5) {
                row.eachCell((cell) => {
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' }
                    };
                });
            }
        });

        // Wyślij plik
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=wycinacz_${orderNumber || 'raport'}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Błąd eksportu Excel:', error);
        res.status(500).json({ error: 'Blad generowania Excel' });
    }
});

// POST /api/export/pdf - Eksport do PDF z QR kodami
app.post('/api/export/pdf', async (req, res) => {
    try {
        const { plans, summary, stockUsageSummary, kerf, orderNumber, timestamp } = req.body;
        const doc = new PDFDocument();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=wycinacz_${orderNumber || 'raport'}.pdf`);

        doc.pipe(res);

        // Nagłówek
        doc.fontSize(18).text('Wyniki optymalizacji ciecia', { underline: true });
        doc.moveDown(0.5);

        // Informacje o zamówieniu
        if (orderNumber) {
            doc.fontSize(12).text(`Numer zamowienia: ${orderNumber}`, { bold: true });
        }

        if (timestamp) {
            const date = new Date(timestamp);
            doc.fontSize(10).text(`Data: ${date.toLocaleString('pl-PL')}`);
        }

        doc.moveDown();

        if (kerf && kerf > 0) {
            doc.fontSize(10).text(`Strata na ciecie (kerf): ${kerf} mm`, { color: 'gray' });
            doc.moveDown(0.5);
        }

        // Plan cięcia z QR kodami
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const usedLength = plan.cuts.reduce((sum, c) => sum + c, 0);
            const kerfLoss = plan.kerfLoss || 0;
            const wastePercent = ((plan.waste / plan.stockLength) * 100).toFixed(1);

            // Generuj QR kod
            const qrData = JSON.stringify({
                order: orderNumber || 'BRAK',
                bar: i + 1,
                length: plan.stockLength,
                cuts: plan.cuts,
                waste: plan.waste
            });

            const qrCodeBuffer = await QRCode.toBuffer(qrData, {
                width: 100,
                margin: 1
            });

            // Zapisz pozycję Y przed dodaniem tekstu
            const startY = doc.y;

            doc.fontSize(12).text(
                `Sztanga #${i + 1} (${plan.stockLength}mm): ${plan.cuts.join(', ')}mm`
            );

            let detailText = ` Uzyte: ${usedLength}mm`;
            if (kerfLoss > 0) {
                detailText += ` + kerf: ${kerfLoss}mm`;
            }
            detailText += ` | Strata: ${plan.waste}mm (${wastePercent}%)`;

            doc.fontSize(10).text(detailText);

            // Dodaj QR kod obok tekstu
            doc.image(qrCodeBuffer, doc.page.width - 120, startY, {
                width: 80,
                height: 80
            });

            doc.moveDown(0.5);
        }

        doc.moveDown();
        doc.fontSize(14).text(summary, { bold: true });

        if (stockUsageSummary) {
            doc.moveDown(0.5);
            doc.fontSize(12).text(stockUsageSummary);
        }

        doc.end();
    } catch (error) {
        console.error('Błąd eksportu PDF:', error);
        res.status(500).json({ error: 'Blad generowania PDF' });
    }
});

// POST /api/export/txt - Eksport do TXT
app.post('/api/export/txt', (req, res) => {
    try {
        const { plans, summary, stockUsageSummary, kerf, orderNumber, timestamp } = req.body;

        let text = 'Wyniki optymalizacji ciecia\n';
        text += '============================\n\n';

        if (orderNumber) {
            text += `Numer zamowienia: ${orderNumber}\n`;
        }

        if (timestamp) {
            const date = new Date(timestamp);
            text += `Data: ${date.toLocaleString('pl-PL')}\n`;
        }

        text += '\n';

        if (kerf && kerf > 0) {
            text += `Strata na ciecie (kerf): ${kerf} mm\n\n`;
        }

        plans.forEach((plan, index) => {
            const usedLength = plan.cuts.reduce((sum, c) => sum + c, 0);
            const kerfLoss = plan.kerfLoss || 0;
            const wastePercent = ((plan.waste / plan.stockLength) * 100).toFixed(1);

            text += `Sztanga #${index + 1} (${plan.stockLength}mm): ${plan.cuts.join(', ')}mm\n`;

            let detailText = ` Uzyte: ${usedLength}mm`;
            if (kerfLoss > 0) {
                detailText += ` + kerf: ${kerfLoss}mm`;
            }
            detailText += ` | Strata: ${plan.waste}mm (${wastePercent}%)\n\n`;
            text += detailText;
        });

        text += `${summary}\n`;

        if (stockUsageSummary) {
            text += `${stockUsageSummary}\n`;
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=wycinacz_${orderNumber || 'raport'}.txt`);
        res.send(text);
    } catch (error) {
        res.status(500).json({ error: 'Blad generowania TXT' });
    }
});

// GET /api/profiles - Pobierz zapisane profile
app.get('/api/profiles', (req, res) => {
    const defaultProfiles = {
        "Stal konstrukcyjna": [6000, 12100, 15100],
        "Profil aluminiowy": [3000, 6000, 7000],
        "Rura stalowa": [6000, 12000],
        "Pret okragly": [3000, 6000, 9000],
        "Customowy": []
    };

    res.json(defaultProfiles);
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