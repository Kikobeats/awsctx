#!/usr/bin/env node

const { select } = require('@inquirer/prompts')
const { execSync } = require('child_process')
const { styleText } = require('node:util')
const path = require('path')
const ini = require('ini')
const mri = require('mri')
const fs = require('fs')
const os = require('os')

const AWS_DIR = path.join(os.homedir(), '.aws')
const profileFile = path.join(AWS_DIR, 'awsctx')
const configPath = path.join(AWS_DIR, 'config')
const ssoCacheDir = path.join(AWS_DIR, 'sso', 'cache')

function getAWSProfiles () {
  const credentialsPath = path.join(os.homedir(), '.aws', 'credentials')
  const configPath = path.join(os.homedir(), '.aws', 'config')
  const profiles = new Set()

  const extractProfiles = (filePath, stripProfilePrefix = false) => {
    if (!fs.existsSync(filePath)) return

    const data = ini.parse(fs.readFileSync(filePath, 'utf8'))
    for (const key of Object.keys(data)) {
      let profileName = key.trim()
      if (stripProfilePrefix && profileName.startsWith('profile ')) {
        profileName = profileName.slice('profile '.length)
      }
      profiles.add(profileName)
    }
  }

  extractProfiles(credentialsPath) // no "profile " prefix in this file
  extractProfiles(configPath, true) // "profile " prefix used here

  return Array.from(profiles)
}

function getSSOConfig () {
  if (!fs.existsSync(configPath)) return {}
  const raw = fs.readFileSync(configPath, 'utf8')
  const config = ini.parse(raw)

  const ssoProfiles = {}

  for (const [key, value] of Object.entries(config)) {
    const profileName = key.replace(/^profile /, '')
    if (value.sso_start_url && value.sso_account_id && value.sso_role_name) {
      ssoProfiles[profileName] = value
    }
  }

  return ssoProfiles
}

function isSSOSessionValid () {
  if (!fs.existsSync(ssoCacheDir)) return false

  const now = new Date()
  const files = fs.readdirSync(ssoCacheDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const fullPath = path.join(ssoCacheDir, file)
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
      if (data.expiresAt) {
        const expiry = new Date(data.expiresAt)
        if (expiry > now) return true
      }
    } catch (_) {
      // ignore malformed files
    }
  }

  return false
}

async function main () {
  const profiles = getAWSProfiles()
  const ssoProfiles = getSSOConfig()
  const currentProfile = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : 'default'

  if (profiles.length === 0) {
    console.error('No AWS profiles found.')
    process.exit(1)
  }

  const flags = mri(process.argv.slice(2), {
    alias: {
      c: 'current',
      h: 'help'
    }
  })

  if (flags.help) {
    console.log(require('./help.js'))
    process.exit(0)
  }

  if (flags.current) {
    console.log(currentProfile)
    process.exit(0)
  }

  try {
    const selectedProfile = await select({
      message: 'Select an AWS profile:',
      choices: profiles.map(profile => {
        const isCurrent = profile === currentProfile
        return {
          value: profile,
          name: isCurrent ? `${profile} ${styleText('gray', '(current)')}` : profile
        }
      }).sort((a, b) => a.name.localeCompare(b.name))
    })

    fs.writeFileSync(profileFile, selectedProfile)

    if (selectedProfile in ssoProfiles) {
      if (!isSSOSessionValid()) {
        execSync(`aws sso login --profile ${selectedProfile}`, { stdio: 'inherit' })
      }
    }

    execSync(`exec ${process.env.SHELL}`, { stdio: 'inherit' })
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      process.exit(0)
    }
    throw error
  }
}

main()
