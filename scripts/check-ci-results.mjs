const results = Object.entries(JSON.parse(process.env.CI_NEEDS ?? '{}'))
if (!results.length) {
  console.error('No upstream checks were reported')
  process.exitCode = 1
}
for (const [name, check] of results) {
  if (check.result === 'success') console.log(`${name}: success`)
  else {
    console.error(`${name}: ${check.result}`)
    process.exitCode = 1
  }
}
