
var Lang = require("lang.js"),
  paths = require('@paths'),
  commands = require('@commands'),
  botStuff = require('@helpers/bot-stuff'),
  MessageSSML = require('@models/MessageSSML'),
  Common = require('@helpers/common'),
  langmap = require('@helpers/langmap'),
  auth = require('@auth'),
  fs = require('fs'),
  stream = require('stream'),
  streamifier = require('streamifier'),
  prism = require('prism-media');
   
var TIMEOUT_NEGLECT = 120 * 60 * 1000; // 2 hours

class Server {

  constructor(guild, world) {
    this.server_id = guild.id;

    var state_data = this.loadState() || {};

    this.server_name = guild.name;
    this.audioEmojis = state_data.audioEmojis || {};
    this.memberSettings = state_data.memberSettings || {};
    this.textrules = state_data.textrules || { "o\\/": "wave", "\\\\o": "wave ack", "\\\\o\\/": "hooray", "\\(y\\)": "thumbs up", "\\(n\\)": "thumbs down" };
    this.bound_to = null;
    this.voiceConnection = null;
    this.permitted = {};
    this.neglect_timeout = null;
    this.language = state_data.language || 'en-AU';
    this.restrictions = state_data.restrictions || [];
    this.fallbackLang = 'en';
    this.created = state_data.created || new Date();
    this.updated = new Date();
    this.world = world;
    this.guild = guild;

    this.commandResponses = new Lang({
      messages: require('@src/lang.json'),
      locale: langmap.get(this.language).root,
      fallback: this.fallbackLang
    });

    this.messages = {};
  };

  // GuildMember
  setMaster(member) {
    this.bound_to = member;
    this.permit(member.id);
    this.resetNeglectTimeout();
    this.save();
  };

  addSettings(key, add) {
    if (typeof add == 'object' && !this[key]) this[key] = {};
    if (this[key]) {
      this[key] = {
        ...this[key],
        ...add
      }
    }
  };

  addMemberSetting(member, name, value) {
    if (!this.memberSettings) this.memberSettings = {};
    if (!this.memberSettings[member.id]) {
      this.memberSettings[member.id] = {};
    }

    this.memberSettings[member.id][name] = value;
    this.save();
    return value;
  };


  clearMemberSettings(member) {
    if (!this.memberSettings) this.memberSettings = {};
    this.memberSettings[member.id] = {};
    this.save();
  };

  getMemberSetting(member, name) {
    if (!this.memberSettings || !this.memberSettings[member.id] || !this.memberSettings[member.id][name]) return null;
    return this.memberSettings[member.id][name];
  };

  deleteMemberSetting(member, name) {
    if (!this.memberSettings || !this.memberSettings[member.id] || !this.memberSettings[member.id][name]) return;
    delete this.memberSettings[member.id][name];
  };

  getMemberSettings(member) {
    if (!this.memberSettings || !this.memberSettings[member.id]) return {};
    return this.memberSettings[member.id];
  };

  lang(key, params) {
    if (this.isLangKey(key)) {
      return this.messages[key];
    }
    
    if ( !params ) params = {};

    var command_char = auth.command_char;
    var title = params.title || this.world.default_title;
    
    params = {
      ...(params),
      command_char,
      title 
    }

    return this.commandResponses.get.apply(this.commandResponses, [
      key,
      params
    ]);
  };
  
  isLangKey(possible_key) {
    return this.messages && this.messages[possible_key];
  };

  // GuildMember
  isMaster(member) {
    if (!member) return false;
    if (!this.bound_to) return false;
    return this.bound_to.id == member.id;
  };

  // true if this server is bound to a user already
  isBound() {
    return this.bound_to != null;
  };

  // does this server think it's in a voice channel
  inChannel() {
    return this.voiceConnection != null;
  };

  release(callback) {
    var server = this;
    if (!server.voiceConnection) return;
    if (server.leaving) return; // dont call it twice dude
    server.voiceConnection.disconnect();
  };
  
  // get the server to join a voice channel
  // NOTE: this is async, so if you want to run a continuation use .then on the promise returned
  joinVoiceChannel(voiceChannel) {

    var server = this;
    if (server.connecting) return Common.error('joinVoiceChannel(' + voiceChannel.id + '): tried to connect twice!');
    if (server.inChannel()) return Common.error('joinVoiceChannel(' + voiceChannel.id + '): already joined to ' + server.voiceConnection.channel.id + '!');
    server.connecting = true;
    
    console.log(voiceChannel);
    
    var p = voiceChannel.join()
      .then(connection => {
        connection.on('closing', () => {
          server.leaving = true;
          server.bound_to = null;
          server.stop('voiceClosing'); // stop playing
          server.permitted = {};
          clearTimeout(server.neglect_timeout);
        });
        connection.on('disconnect', () => {
          var server = this;
          server.voiceConnection = null;
          server.leaving = false;
          server.world.setPresence();
          //callback();
        });
        server.voiceConnection = connection;
        server.save();
        server.world.setPresence();
        server.connecting = false;
      }, error => {
        server.stop('joinError');
        server.connecting = false;
        Common.error(error); 
      });
      
    return p;
  };
  
  // permit another user to speak
  permit(snowflake_id) {    
    this.resetNeglectTimeout();
    this.permitted[snowflake_id] = {};
    this.save();
  };

  // unpermit another user to speak
  unpermit(snowflake_id) {
    this.resetNeglectTimeout();
    this.permitted[snowflake_id] = null;
    this.save();
  };

  // is this user permitted to speak
  isPermitted(member) {
    if (!member) return false;
    for(var snowflake_id in this.permitted) {
      if (this.permitted[snowflake_id])
        if (snowflake_id == member.id || member.roles.has(member.id)) 
          return true;
    }
    return false;
  };

  // reset the timer that unfollows a user if they dont use the bot
  resetNeglectTimeout() {
    var server = this;

    var neglected_timeout = function () {
      server.neglected();
    };

    clearTimeout(server.neglect_timeout);
    server.neglect_timeout = setTimeout(neglected_timeout, TIMEOUT_NEGLECT);
  };

  // called when the neglect timeout expires
  neglected() {
    var server = this;

    // delay for 3 seconds to allow the bot to talk
    var neglectedrelease = function () {
      var timeout_neglectedrelease = function () { 
        Common.out('neglected: in chan');
        server.release(); 
      };
      setTimeout(timeout_neglectedrelease, 3000);
    };

    if (server.inChannel()) {
      server.talk("I feel neglected, I'm leaving", null, neglectedrelease);
    } else {
      Common.out('neglected: server.release() not in chan');
      server.release();
    }
  };

  // run this to cleanup resources before shutting down
  shutdown() {

    Common.out("shutdown(): " + (new Error()).stack);
    var server = this;

    if (server.inChannel()) {
      server.talk("The server is shutting down", null, () => server.release());
    }
    else {
      server.release();
    }
  };

  // when the server is deleted or shutdown or disconnected run this to cleanup things
  dispose() {
    this.shutdown();
    clearTimeout(this.neglect_timeout);
  };

  // save the state file
  save(_filename) {

    var self = this;
    this.updated = new Date();
    function replacer(key, value) {
      if (key.endsWith("_timeout")) return undefined; // these keys are internal timers that we dont want to save
      if (key == "commandResponses") return undefined;
      if (key == "voiceConnection") return undefined;
      if (key == "bound_to") return undefined;
      if (key == "world") return undefined;
      if (key == "guild") return undefined;
      if (key == "voiceDispatcher") return undefined;
      else return value;
    };

    if (!_filename) _filename = paths.config + "/" + self.server_id + ".server";
    fs.writeFileSync(_filename, JSON.stringify(self, replacer), 'utf-8');
  };

  // load the state file
  loadState() {
    var self = this;
    var _filename = paths.config + "/" + self.server_id + ".server";

    if (fs.existsSync(_filename)) {
      return JSON.parse(fs.readFileSync(_filename));
    }

    return null;
  };
  
  
  // speak a message in a voice channel
  talk(message, options, callback) {

    var server = this;
    if (!server.inChannel()) return;
    if (!options) options = {};

    var settings = {
      gender: options.gender == 'default' ? 'NEUTRAL' : options.gender,
      language: options.language == 'default' ? 'en-AU' : options.language || server.language
    }

    if (options.name != 'default') settings.name = options.name;
    if (options.pitch != 'default') settings.pitch = options.pitch;
    if (options.speed != 'default') settings.speed = options.speed;

    server.resetNeglectTimeout();

    if (!callback) callback = function () { };

    var request = {
      input: { text: message },
      // Select the language and SSML Voice Gender (optional)
      voice: {
        languageCode: settings.language || '',
        ssmlGender: settings.gender || 'NEUTRAL',
        name: settings.name || ''
      },
      // Select the type of audio encoding
      audioConfig: {
        audioEncoding: 'OGG_OPUS',
        //audioEncoding: 'MP3',
        pitch: settings.pitch || 0.0,
        speakingRate: settings.speed || 1.0,
        volume_gain_db: -6.0,
        //sample_rate_hertz: 12000,
        //effects_profile_id: ['telephony-class-application']
      },
    };

    request.input = { text: null, ssml: message };

    console.log("tts");
    console.log(request);

    // Performs the Text-to-Speech request
    botStuff.tts().synthesizeSpeech(request, (err, response) => {
      if (err) {
        Common.error(err);
        return;
      }
      try {
        // might have to queue the content if its playing currently
        console.log("tts-buildstream");
        server.playAudioContent(response.audioContent, callback);
      }
      catch (e) {
        Common.error(e);
      }
    });
  };
  
  // stop all currently playing audio and empty the audio queue
  stop(reason) {
    this.audioQueue = [];
    if ( this.voiceDispatcher ) this.voiceDispatcher.end(reason);
  };
  
  // internal function for playing audio content returned from the TTS API and queuing it
  playAudioContent(audioContent, callback) {

    var server = this;
    var readable = audioContent;

    if ( !server.voiceConnection ) return Common.error("Tried to play audio content when there's no voice connection. " + (new Error()).stack);
    if ( server.leaving ) return;

    if (!( readable instanceof stream.Readable) ) {
      readable = new streamifier.createReadStream(audioContent);
    }

    // queue it up if there's something playing
    // queueFunc is a call containing both the callback and the content
    if ( server.playing ) {
      if ( !server.audioQueue ) server.audioQueue = [];
      var queueFunc = () => server.playAudioContent(readable, callback);
      server.audioQueue.push(queueFunc);
      return;
    }
    
    // play the content
    server.playing = true;
    console.log("tts-play");
    if ( server.voice_timeout) clearTimeout(server.voice_timeout);
    server.voice_timeout = setTimeout(() => server.voiceDispatcher ? server.voiceDispatcher.end('timeout') : null, 10000);
    server.voiceDispatcher = server.voiceConnection
      .playOpusStream(readable.pipe(new prism.opus.OggDemuxer()))
      .on('end', reason => {
        console.log("tts-end");
        clearTimeout(server.voice_timeout);
        server.playing = false;
        server.voiceDispatcher = null;
        server.voice_timeout = null;
        callback();
        if ( !server.audioQueue ) return;
        var nextAudio = server.audioQueue.shift();
        if ( nextAudio ) nextAudio();
      })
      .on('error', error => Common.error(error));
      server.voiceDispatcher.passes = 1;
  };

  // call this if you want to check a msg content is valid and run it through translation
  speak(message) {

    var server = this;
    var settings = server.getMemberSettings(message.member);

    if (
      message.cleanContent.length < 1 ||
      Common.isMessageExcluded(message.cleanContent) ||
      !server.inChannel() ||
      !server.isPermitted(message.member) ||
      settings.muted
    ) return;
    
    var accept = commands.notify('validate', { message: message, server: server });

    if (accept === false) return; // nerf the message because it didnt validate

    var content = Common.cleanMessage(message.cleanContent);


    var ret = commands.notify('message', { message: message, content: content, server: server });
    if (ret !== null) content = ret.trim();

    if ( content.length < 1 ) return;    

    function _speak(msg) {
      var ssml = new MessageSSML(msg, { server: server }).build();
      server.talk(ssml, settings);
    }

    var tolang = server.getMemberSetting(message.member, 'toLanguage');
    if (tolang && !tolang == "default") {

      botStuff.translate_client
        .translate(content, tolang)
        .then(results => {
          _speak(results[0]);
        })
        .catch(Common.error);
    } else {
      _speak(content);
    };
  };

};

module.exports = Server;
