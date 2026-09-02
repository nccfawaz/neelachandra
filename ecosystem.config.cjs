module.exports = {
  apps: [
    {
      name: 'ncc',
      script: 'dist/server.js',
      cwd: '/home/user/webapp',
      // .env is loaded here rather than by dotenv inside the app, because
      // Hostinger's Node app manager sets real environment variables and the
      // app must read them the same way in both places.
      env: Object.assign(
        { NODE_ENV: 'development', PORT: 3000 },
        require('node:fs')
          .readFileSync(__dirname + '/.env', 'utf8')
          .split('\n')
          .reduce((acc, line) => {
            const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
            if (m) acc[m[1]] = m[2].replace(/^"|"$/g, '')
            return acc
          }, {})
      ),
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
  ],
}
