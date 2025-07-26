const { styleText } = require('node:util')

const gray = text => styleText('gray', text)
const white = text => styleText('white', text)

module.exports = `
  ${white('awsctx')}                       : ${gray('list the profiles')}
  ${white('awsctx <PROFILE>')}             : ${gray('switch to profile <PROFILE>')}
  ${white('awsctx -c, --current')}         : ${gray('show the current profile name')}
  ${white('awsctx -h,--help')}             : ${gray('show this message')}
`
