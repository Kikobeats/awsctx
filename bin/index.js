#!/usr/bin/env node

const debug = require('debug-logfmt')('awsctx')
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

  // no "profile " prefix in this file
  extractProfiles(credentialsPath)
  // "profile " prefix used here
  extractProfiles(configPath, true)

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
  debug('checking SSO session validity', { ssoCacheDir })

  if (!fs.existsSync(ssoCacheDir)) {
    debug('SSO cache directory does not exist', { ssoCacheDir })
    return false
  }

  const now = new Date()
  const files = fs.readdirSync(ssoCacheDir).filter(f => f.endsWith('.json'))
  debug('found cache files', { files, count: files.length })

  const validFiles = files.filter(file => {
    const fullPath = path.join(ssoCacheDir, file)
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
      debug('checking cache file', { file, keys: Object.keys(data) })

      if (data.accessToken && data.expiresAt) {
        const expiry = new Date(data.expiresAt)
        const isValid = expiry > now
        debug('access token found', { file, expiresAt: data.expiresAt, isValid, timeLeft: expiry - now })
        return isValid
      }

      if (data.startUrl && data.expiresAt) {
        const expiry = new Date(data.expiresAt)
        const isValid = expiry > now
        debug('SSO session found', { file, startUrl: data.startUrl, expiresAt: data.expiresAt, isValid, timeLeft: expiry - now })
        return isValid
      }

      debug('file does not contain valid token data', { file })
      return false
    } catch (error) {
      debug('failed to parse cache file', { file, error: error.message })
      return false
    }
  })

  const isValid = validFiles.length > 0
  debug('SSO session validation result', { validFiles, isValid })
  return isValid
}

async function main () {
  const profiles = getAWSProfiles()
  const ssoProfiles = getSSOConfig()
  const currentProfile = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : 'default'

  debug('initialized', {
    profiles,
    ssoProfiles: Object.keys(ssoProfiles),
    currentProfile,
    profileFile,
    ssoCacheDir
  })

  if (profiles.length === 0) {
    console.error('No AWS profiles found.')
    process.exit(1)
  }

  const flags = mri(process.argv.slice(2), {
    alias: {
      c: 'current',
      h: 'help',
      r: 'refresh'
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

  if (flags.debug) {
    process.env.DEBUG = 'awsctx'
    debug('debug mode enabled')
  }

  if (flags.refresh) {
    const profile = flags._[0] || currentProfile
    debug('refresh requested', { profile, isSSOProfile: profile in ssoProfiles })
    if (profile in ssoProfiles) {
      execSync(`aws sso login --profile ${profile}`, { stdio: 'inherit' })
      process.exit(0)
    } else {
      console.error(`Profile '${profile}' is not an SSO profile`)
      process.exit(1)
    }
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
      debug('selected profile is SSO profile', JSON.stringify({ selectedProfile, ssoConfig: ssoProfiles[selectedProfile] }, null, 2))
      const isValid = isSSOSessionValid()
      if (!isValid) {
        debug('SSO session invalid, initiating login', { selectedProfile })
        execSync(`aws sso login --profile ${selectedProfile}`, { stdio: 'inherit' })
      } else {
        debug('SSO session is valid, skipping login', { selectedProfile })
      }
    } else {
      debug('selected profile is not SSO profile', { selectedProfile })
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
