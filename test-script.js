const { parseConfig, encodeConfig } = require('./src/utils/config');
(async()=>{
  const sample={geminiApiKey:'x',sourceLanguages:['eng'],targetLanguages:['spa'],learnMode:true,learnPlacement:'top',learnOrder:'source-top',learnTargetLanguages:['spa']};
  const b64=encodeConfig(sample);
  const parsed=await parseConfig(b64,{isLocalhost:true});
  console.log('parsed learnPlacement', parsed.learnPlacement);
})();
