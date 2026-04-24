import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database("faculty_planner.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS academic_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS timetable_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL, -- 0 (Sun) to 6 (Sat)
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    subject TEXT NOT NULL,
    semester TEXT NOT NULL,
    division TEXT NOT NULL,
    type TEXT NOT NULL, -- 'lecture' or 'lab'
    faculty_name TEXT,
    lecture_number INTEGER,
    recurrence_type TEXT DEFAULT 'weekly', -- 'weekly', 'biweekly', 'monthly', 'specific'
    active_from TEXT, -- Optional date
    active_to TEXT, -- Optional date
    specific_dates TEXT, -- Comma-separated dates for 'specific' type
    FOREIGN KEY (term_id) REFERENCES academic_terms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS schedule_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL UNIQUE,
    start_time TEXT NOT NULL DEFAULT '09:00',
    lecture_duration INTEGER NOT NULL DEFAULT 60,
    breaks_json TEXT NOT NULL DEFAULT '[]',
    overlap_strategy TEXT NOT NULL DEFAULT 'error', -- 'error', 'lecture_over_lab', 'higher_lecture_number'
    auto_adjust_breaks INTEGER NOT NULL DEFAULT 0, -- 0 for false, 1 for true
    FOREIGN KEY (term_id) REFERENCES academic_terms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS generated_lectures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    subject TEXT,
    semester TEXT,
    division TEXT,
    type TEXT NOT NULL, -- 'lecture', 'lab', 'holiday'
    faculty_name TEXT,
    lecture_number INTEGER,
    holiday_name TEXT,
    FOREIGN KEY (term_id) REFERENCES academic_terms(id) ON DELETE CASCADE
  );
`);

// Migrations for existing databases
try {
  db.exec(`ALTER TABLE timetable_entries ADD COLUMN lecture_number INTEGER`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE generated_lectures ADD COLUMN lecture_number INTEGER`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE generated_lectures ADD COLUMN holiday_name TEXT`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE timetable_entries ADD COLUMN recurrence_type TEXT DEFAULT 'weekly'`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE timetable_entries ADD COLUMN active_from TEXT`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE timetable_entries ADD COLUMN active_to TEXT`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE timetable_entries ADD COLUMN specific_dates TEXT`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE timetable_entries ADD COLUMN faculty_name TEXT`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE generated_lectures ADD COLUMN faculty_name TEXT`);
} catch (e) { /* Column might already exist */ }

try {
  db.exec(`ALTER TABLE schedule_settings ADD COLUMN overlap_strategy TEXT DEFAULT 'error'`);
} catch (e) { /* Column might already exist */ }
try {
  db.exec(`ALTER TABLE schedule_settings ADD COLUMN auto_adjust_breaks INTEGER DEFAULT 0`);
} catch (e) { /* Column might already exist */ }

db.exec(`
  -- Seed common Indian holidays for 2026 if empty
  INSERT OR IGNORE INTO holidays (date, description) VALUES 
  ('2026-01-26', 'Republic Day'),
  ('2026-03-03', 'Holi'),
  ('2026-04-03', 'Good Friday'),
  ('2026-08-15', 'Independence Day'),
  ('2026-10-02', 'Mahatma Gandhi Jayanti'),
  ('2026-11-08', 'Diwali'),
  ('2026-12-25', 'Christmas');
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/terms", (req, res) => {
    const terms = db.prepare("SELECT * FROM academic_terms ORDER BY start_date DESC").all();
    res.json(terms);
  });

  app.post("/api/terms", async (req, res) => {
    const { name, start_date, end_date } = req.body;
    if (!name || !start_date || !end_date) {
      return res.status(400).json({ error: "Name, start date, and end date are required" });
    }
    try {
      const result = db.prepare(`
        INSERT INTO academic_terms (name, start_date, end_date)
        VALUES (?, ?, ?)
      `).run(name, start_date, end_date);
      
      const termId = result.lastInsertRowid;

      // Automatically fetch holidays for the years involved (defaulting to IN)
      const startYear = new Date(start_date).getFullYear();
      const endYear = new Date(end_date).getFullYear();
      const years = Array.from(new Set([startYear, endYear]));

      for (const year of years) {
        try {
          const fetchRes = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/IN`);
          if (fetchRes.ok) {
            const text = await fetchRes.text();
            if (text) {
              try {
                const data = JSON.parse(text);
                const insertHoliday = db.prepare("INSERT OR IGNORE INTO holidays (date, description) VALUES (?, ?)");
                for (const h of data) {
                  insertHoliday.run(h.date, h.localName || h.name);
                }
              } catch (e) {
                console.error("Failed to parse JSON for year", year, e);
              }
            }
          }
        } catch (err) {
          console.error("Failed to fetch holidays for year", year, err);
        }
      }

      res.json({ success: true, id: termId });
    } catch (e) {
      res.status(500).json({ error: "Failed to create academic term" });
    }
  });

  app.delete("/api/terms/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM academic_terms WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete academic term" });
    }
  });

  app.get("/api/holidays", (req, res) => {
    const holidays = db.prepare("SELECT * FROM holidays ORDER BY date ASC").all();
    res.json(holidays);
  });

  app.post("/api/holidays", (req, res) => {
    const { date, description } = req.body;
    if (!date || !description) {
      return res.status(400).json({ error: "Date and description are required" });
    }
    try {
      db.prepare("INSERT INTO holidays (date, description) VALUES (?, ?)").run(date, description);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: "This holiday already exists in your list" });
    }
  });

  app.delete("/api/holidays/:id", (req, res) => {
    try {
      const result = db.prepare("DELETE FROM holidays WHERE id = ?").run(req.params.id);
      if (result.changes === 0) {
        return res.status(404).json({ error: "Holiday not found" });
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete holiday" });
    }
  });

  app.delete("/api/holidays", (req, res) => {
    try {
      db.prepare("DELETE FROM holidays").run();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to clear holidays" });
    }
  });

  app.put("/api/holidays/:id", (req, res) => {
    const { date, description } = req.body;
    if (!date || !description) {
      return res.status(400).json({ error: "Date and description are required" });
    }
    try {
      const result = db.prepare("UPDATE holidays SET date = ?, description = ? WHERE id = ?").run(date, description, req.params.id);
      if (result.changes === 0) {
        return res.status(404).json({ error: "Holiday not found" });
      }
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: "Failed to update holiday. Date might be a duplicate." });
    }
  });

  app.get("/api/schedule-settings", (req, res) => {
    const { termId } = req.query;
    if (!termId) {
      return res.status(400).json({ error: "termId is required" });
    }
    let settings = db.prepare("SELECT * FROM schedule_settings WHERE term_id = ?").get(termId);
    if (!settings) {
      // Create default settings if not exists
      db.prepare("INSERT INTO schedule_settings (term_id) VALUES (?)").run(termId);
      settings = db.prepare("SELECT * FROM schedule_settings WHERE term_id = ?").get(termId);
    }
    res.json(settings);
  });

  app.put("/api/schedule-settings", (req, res) => {
    const { term_id, start_time, lecture_duration, breaks_json, overlap_strategy, auto_adjust_breaks } = req.body;
    if (!term_id) {
      return res.status(400).json({ error: "term_id is required" });
    }
    try {
      db.prepare(`
        INSERT INTO schedule_settings (term_id, start_time, lecture_duration, breaks_json, overlap_strategy, auto_adjust_breaks)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(term_id) DO UPDATE SET
          start_time = excluded.start_time,
          lecture_duration = excluded.lecture_duration,
          breaks_json = excluded.breaks_json,
          overlap_strategy = excluded.overlap_strategy,
          auto_adjust_breaks = excluded.auto_adjust_breaks
      `).run(term_id, start_time, lecture_duration, breaks_json, overlap_strategy || 'error', auto_adjust_breaks ?? 0);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to update settings: " + e.message });
    }
  });

  app.get("/api/timetable", (req, res) => {
    const { termId } = req.query;
    if (!termId) {
      return res.status(400).json({ error: "termId is required" });
    }
    const entries = db.prepare("SELECT * FROM timetable_entries WHERE term_id = ?").all(termId);
    res.json(entries);
  });

  app.post("/api/timetable", (req, res) => {
    const { term_id, day_of_week, start_time, end_time, subject, semester, division, type, faculty_name, lecture_number, recurrence_type, active_from, active_to, specific_dates } = req.body;
    
    if (!term_id || !subject || !semester || !division) {
      return res.status(400).json({ error: "Term, Subject, Semester, and Division are required" });
    }

    if (start_time >= end_time) {
      return res.status(400).json({ error: "End time must be after start time" });
    }

    try {
      db.prepare(`
        INSERT INTO timetable_entries (term_id, day_of_week, start_time, end_time, subject, semester, division, type, faculty_name, lecture_number, recurrence_type, active_from, active_to, specific_dates)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(term_id, day_of_week, start_time, end_time, subject, semester, division, type, faculty_name || null, lecture_number || null, recurrence_type || 'weekly', active_from || null, active_to || null, specific_dates || null);
      res.json({ success: true });
    } catch (e: any) {
      console.error("Error adding timetable entry:", e);
      res.status(500).json({ error: "Failed to add timetable entry: " + e.message });
    }
  });

  app.delete("/api/timetable/:id", (req, res) => {
    try {
      const result = db.prepare("DELETE FROM timetable_entries WHERE id = ?").run(req.params.id);
      if (result.changes === 0) {
        return res.status(404).json({ error: "Entry not found" });
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete entry" });
    }
  });

  app.get("/api/schedule", (req, res) => {
    const { termId } = req.query;
    if (!termId) {
      return res.status(400).json({ error: "termId is required" });
    }
    const schedule = db.prepare("SELECT * FROM generated_lectures WHERE term_id = ? ORDER BY date ASC, start_time ASC").all(termId);
    res.json(schedule);
  });

  app.post("/api/generate", (req, res) => {
    const { termId } = req.body;
    if (!termId) {
      return res.status(400).json({ error: "termId is required" });
    }

    const term = db.prepare("SELECT * FROM academic_terms WHERE id = ?").get(termId);
    if (!term || !term.start_date || !term.end_date) {
      return res.status(400).json({ error: "Term not found or dates not set" });
    }

    const timetable = db.prepare("SELECT * FROM timetable_entries WHERE term_id = ? ORDER BY start_time ASC").all(termId);
    if (timetable.length === 0) {
      return res.status(400).json({ error: "Your weekly timetable for this term is empty. Add some entries first" });
    }

    const holidays = db.prepare("SELECT date, description FROM holidays").all();
    const holidayMap = new Map(holidays.map(h => [h.date, h.description]));
    
    const settings = db.prepare("SELECT * FROM schedule_settings WHERE term_id = ?").get(termId);
    let breaks: { after_lecture: number, duration: number }[] = [];
    let overlapStrategy = 'error';
    let autoAdjustBreaks = false;

    if (settings) {
      if (settings.breaks_json) {
        try { breaks = JSON.parse(settings.breaks_json); } catch(e) {}
      }
      overlapStrategy = settings.overlap_strategy || 'error';
      autoAdjustBreaks = !!settings.auto_adjust_breaks;
    }

    try {
      db.prepare("DELETE FROM generated_lectures WHERE term_id = ?").run(termId);

      const termStart = new Date(term.start_date + "T00:00:00Z");
      const termEnd = new Date(term.end_date + "T00:00:00Z");

      if (termStart > termEnd) {
        return res.status(400).json({ error: "Term start date must be before or equal to end date" });
      }

      const insert = db.prepare(`
        INSERT INTO generated_lectures (term_id, date, start_time, end_time, subject, semester, division, type, faculty_name, lecture_number, holiday_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const transaction = db.transaction(() => {
        let count = 0;
        
        // First, generate all dates in the term
        let current = new Date(termStart);
        while (current <= termEnd) {
          const dateStr = current.toISOString().split("T")[0];
          const dayOfWeek = current.getUTCDay();
          
          // Check if it's a holiday
          if (holidayMap.has(dateStr)) {
            insert.run(termId, dateStr, null, null, null, null, null, 'holiday', null, null, holidayMap.get(dateStr));
            count++;
            current.setUTCDate(current.getUTCDate() + 1);
            continue;
          }

          // Skip weekends (Saturday = 6, Sunday = 0)
          if (dayOfWeek === 0 || dayOfWeek === 6) {
            insert.run(termId, dateStr, null, null, null, null, null, 'weekend', null, null, dayOfWeek === 0 ? 'Sunday' : 'Saturday');
            count++;
            current.setUTCDate(current.getUTCDate() + 1);
            continue;
          }

          // Find timetable entries for this day of the week
          const dayEntries = timetable.filter(e => e.day_of_week === dayOfWeek);
          let includedEntries = [];
          
          for (const entry of dayEntries) {
            // Check recurrence and active dates
            const isWithinRange = (!entry.active_from || dateStr >= entry.active_from) && 
                                 (!entry.active_to || dateStr <= entry.active_to);
            
            if (!isWithinRange) continue;

            let shouldInclude = false;
            if (entry.recurrence_type === 'weekly' || !entry.recurrence_type) {
              shouldInclude = true;
            } else if (entry.recurrence_type === 'biweekly') {
              const diffTime = Math.abs(current.getTime() - termStart.getTime());
              const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
              const weekNumber = Math.floor(diffDays / 7);
              if (weekNumber % 2 === 0) {
                shouldInclude = true;
              }
            } else if (entry.recurrence_type === 'monthly') {
               const date = current.getUTCDate();
               if (date <= 7) { // First occurrence of this day in the month
                 shouldInclude = true;
               }
            } else if (entry.recurrence_type === 'specific') {
               if (entry.specific_dates) {
                 const dates = entry.specific_dates.split(',').map((d: any) => d.trim());
                 if (dates.includes(dateStr)) {
                   shouldInclude = true;
                 }
               }
            }

            if (shouldInclude) {
              includedEntries.push({...entry}); // Clone to avoid modifying original
            }
          }
          
          if (includedEntries.length > 0) {
            // Sort by start time
            includedEntries.sort((a, b) => a.start_time.localeCompare(b.start_time));
            
            // Overlap Detection and Resolution
            let resolvedEntries = [];
            if (includedEntries.length > 0) {
              resolvedEntries.push(includedEntries[0]);
              for (let i = 1; i < includedEntries.length; i++) {
                const currentEntry = includedEntries[i];
                const lastEntry = resolvedEntries[resolvedEntries.length - 1];
                
                // Check for overlap
                if (currentEntry.start_time < lastEntry.end_time) {
                  if (overlapStrategy === 'error') {
                     throw new Error(`Overlap detected on ${dateStr} between ${lastEntry.subject} (${lastEntry.start_time}-${lastEntry.end_time}) and ${currentEntry.subject} (${currentEntry.start_time}-${currentEntry.end_time})`);
                  } else if (overlapStrategy === 'lecture_over_lab') {
                    if (currentEntry.type === 'lecture' && lastEntry.type === 'lab') {
                      resolvedEntries[resolvedEntries.length - 1] = currentEntry; // Replace lab with lecture
                    } else if (currentEntry.type === 'lab' && lastEntry.type === 'lecture') {
                      // Keep lecture, skip lab
                      continue;
                    } else {
                      // Same type, use lecture number as fallback
                      if ((currentEntry.lecture_number || 0) > (lastEntry.lecture_number || 0)) {
                        resolvedEntries[resolvedEntries.length - 1] = currentEntry;
                      }
                    }
                  } else if (overlapStrategy === 'higher_lecture_number') {
                    if ((currentEntry.lecture_number || 0) > (lastEntry.lecture_number || 0)) {
                       resolvedEntries[resolvedEntries.length - 1] = currentEntry;
                    } else {
                      continue;
                    }
                  }
                } else {
                  resolvedEntries.push(currentEntry);
                }
              }
            }

            for (let i = 0; i < resolvedEntries.length; i++) {
              const entry = resolvedEntries[i];
              const nextEntry = resolvedEntries[i + 1];
              
              let actualEndTime = entry.end_time;

              // Auto-adjust breaks logic
              if (autoAdjustBreaks && entry.lecture_number && nextEntry) {
                const breakAfter = breaks.find(b => b.after_lecture === entry.lecture_number);
                if (breakAfter) {
                  const [nextH, nextM] = nextEntry.start_time.split(':').map(Number);
                  const nextStartMins = nextH * 60 + nextM;
                  
                  const [endH, endM] = entry.end_time.split(':').map(Number);
                  const currentEndMins = endH * 60 + endM;
                  
                  const breakEndMins = currentEndMins + breakAfter.duration;
                  
                  if (breakEndMins > nextStartMins) {
                    // Overlap! Adjust lecture end time so break ends at next lecture start
                    const newEndMins = nextStartMins - breakAfter.duration;
                    const newEndH = Math.floor(newEndMins / 60).toString().padStart(2, '0');
                    const newEndM = (newEndMins % 60).toString().padStart(2, '0');
                    actualEndTime = `${newEndH}:${newEndM}`;
                    
                    // Ensure we didn't make the lecture start after it ends
                    if (actualEndTime <= entry.start_time) {
                       actualEndTime = entry.end_time; // Revert if invalid
                    }
                  }
                }
              }

              insert.run(termId, dateStr, entry.start_time, actualEndTime, entry.subject, entry.semester, entry.division, entry.type, entry.faculty_name, entry.lecture_number, null);
              count++;
              
              // Check if we need to insert a break after this lecture
              if (entry.lecture_number) {
                const breakAfter = breaks.find(b => b.after_lecture === entry.lecture_number);
                if (breakAfter) {
                  // Calculate break end time
                  const [startH, startM] = actualEndTime.split(':').map(Number);
                  const breakMins = startH * 60 + startM + breakAfter.duration;
                  const breakEndH = Math.floor(breakMins / 60).toString().padStart(2, '0');
                  const breakEndM = (breakMins % 60).toString().padStart(2, '0');
                  const breakEndTime = `${breakEndH}:${breakEndM}`;
                  
                  insert.run(termId, dateStr, actualEndTime, breakEndTime, 'Break', null, null, 'break', null, null, null);
                  count++;
                }
              }
            }
          } else {
            insert.run(termId, dateStr, null, null, null, null, null, 'off-day', null, null, 'Off Day');
            count++;
          }
          
          current.setUTCDate(current.getUTCDate() + 1);
        }
        
        return count;
      });

      const totalGenerated = transaction();
      res.json({ success: true, count: totalGenerated });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "An unexpected error occurred during generation: " + e.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.delete("/api/schedule", (req, res) => {
    const { termId } = req.query;
    if (!termId) {
      return res.status(400).json({ error: "termId is required" });
    }
    try {
      db.prepare("DELETE FROM generated_lectures WHERE term_id = ?").run(termId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to clear schedule" });
    }
  });

  // Download Source Code Route
  app.get("/api/download-source", async (req, res) => {
    try {
      const { execSync } = await import("child_process");
      const zipPath = path.join(__dirname, "faculty_planner_source.zip");
      
      // Zip everything except node_modules, dist, and hidden git/gemini folders
      execSync(`zip -r ${zipPath} . -x "*/node_modules/*" -x "*/dist/*" -x "*/.git/*" -x "*/.gemini/*"`, {
        cwd: __dirname
      });

      res.download(zipPath, "faculty_planner_source_code.zip", (err) => {
        if (!err) {
          // Clean up zip after download
          import("fs").then(fs => fs.unlinkSync(zipPath)).catch(console.error);
        }
      });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "Failed to generate zip file: " + e.message });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
