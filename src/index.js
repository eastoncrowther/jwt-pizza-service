const app = require('./service.js');
const logger = require('./logger.js');

// Log anything that escapes Express, then exit since the process state is unknown.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, async (err) => {
    console.error(`${event}:`, err);
    await logger.unhandledErrorLogger(err);
    process.exit(1);
  });
}

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
