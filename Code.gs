/**
 * World Travel Memories -> Buffer -> Instagram
 *
 * This is a standalone Google Apps Script project. It uploads the selected
 * Google Drive media to Cloudinary, then gives Buffer the Cloudinary URL.
 *
 * Required Script Property:
 *   BUFFER_API_KEY
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 */

const WTM = Object.freeze({
  ROOT_FOLDER_ID: 'REDACTED_ROOT_FOLDER_ID',
  EXCLUDED_FOLDER_IDS: new Set(['REDACTED_EXCLUDED_FOLDER_ID']),
  TRACKER_NAME: 'World Travel Memories Automation Log',
  TIMEZONE: 'America/Bogota',
  TARGET_HOURS: new Set([9, 12, 15, 18, 21]),
  STARTING_MEDIA_TYPE: 'photo',
  LIVE_DELAY_MINUTES: 3,
  MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
  BUFFER_URL: 'https://api.buffer.com',
  PHOTO_MIME_TYPES: new Set(['image/jpeg', 'image/png']),
  VIDEO_MIME_TYPES: new Set(['video/mp4', 'video/quicktime']),
});

const HEADERS = Object.freeze({
  POSTS: [
    'Created at', 'Mode', 'Folder ID', 'Folder caption', 'File ID', 'File name',
    'Media type', 'Buffer post ID', 'Status', 'Details'
  ],
  CONFIG: ['Key', 'Value'],
});

/**
 * Run once after adding BUFFER_API_KEY to Script Properties.
 * It creates the tracker spreadsheet, finds the connected Buffer Instagram
 * channel, and sets the first live post to use a photo.
 */
function setupWorldTravelAutomation() {
  requireBufferApiKey_();
  const ss = getTracker_();
  ensureState_(ss);
  const channel = discoverInstagramChannel_();
  setConfig_(ss, 'buffer_channel_id', channel.id);
  setConfig_(ss, 'buffer_channel_name', channel.displayName || channel.name);
  Logger.log('Setup complete. Tracker: ' + ss.getUrl());
  Logger.log('Instagram channel: ' + (channel.displayName || channel.name));
}

/**
 * Creates a Buffer DRAFT using one Drive photo delivered through Cloudinary. Nothing is
 * scheduled or posted to Instagram. Open Buffer > Drafts to verify the preview.
 */
function testPublicDrivePhotoDraft() {
  createPublicDriveDraftTest_('photo');
}

/**
 * Creates a Buffer DRAFT using one Drive video delivered through Cloudinary. Nothing is
 * scheduled or posted to Instagram. Open Buffer > Drafts to verify the preview.
 */
function testPublicDriveVideoDraft() {
  createPublicDriveDraftTest_('video');
}

/**
 * Enables live posting. This does not install the time trigger on its own.
 */
function enableWorldTravelAutomation() {
  const ss = getTracker_();
  ensureState_(ss);
  setConfig_(ss, 'automation_enabled', 'true');
  Logger.log('Live automation enabled.');
}

/**
 * Immediately stops the scheduler. Existing posts already created in Buffer
 * are not changed.
 */
function disableWorldTravelAutomation() {
  const ss = getTracker_();
  setConfig_(ss, 'automation_enabled', 'false');
  Logger.log('Live automation disabled.');
}

/**
 * Installs one trigger that checks every five minutes. It publishes once during
 * each target hour: 9 AM, noon, 3 PM, 6 PM, and 9 PM in America/Bogota time.
 */
function installFiveMinuteScheduleCheck() {
  deleteWorldTravelTriggers();
  ScriptApp.newTrigger('worldTravelScheduleCheck')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Five minute schedule check installed.');
}

/**
 * Removes this automation's time trigger. It is safe to run more than once.
 */
function deleteWorldTravelTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(function(trigger) {
      return trigger.getHandlerFunction() === 'worldTravelScheduleCheck';
    })
    .forEach(function(trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
}

/**
 * Trigger entry point. Do not run this manually for a test; use one of the
 * draft test functions above.
 */
function worldTravelScheduleCheck() {
  const ss = getTracker_();
  ensureState_(ss);
  if (getConfig_(ss, 'automation_enabled') !== 'true') return;

  const now = new Date();
  const hour = Number(Utilities.formatDate(now, WTM.TIMEZONE, 'H'));
  if (!WTM.TARGET_HOURS.has(hour)) return;

  const slot = Utilities.formatDate(now, WTM.TIMEZONE, 'yyyy-MM-dd-HH');
  if (getConfig_(ss, 'last_completed_slot') === slot) return;

  let selection = null;
  try {
    const state = getRotationState_(ss);
    selection = selectNextEligibleMedia_(
      state,
      getUsedFileIds_(ss),
      getLastPostedFileIdsByFolder_(ss)
    );
    if (!selection) {
      throw new Error('No uploadable supported media was found in the eligible city rotation.');
    }

    const dueAt = new Date(now.getTime() + WTM.LIVE_DELAY_MINUTES * 60 * 1000).toISOString();
    const result = createBufferPost_(selection, false, dueAt);
    appendPostLog_(ss, {
      mode: 'Live',
      folderId: selection.folderId,
      caption: selection.caption,
      fileId: selection.fileId,
      fileName: selection.fileName,
      mediaType: selection.mediaType,
      bufferPostId: result.id,
      status: 'Scheduled',
      details: 'Buffer due at ' + dueAt + (selection.reused ? ' (reused after this city exhausted unique media)' : '')
    });

    saveRotationState_(ss, selection.stateAfter);
    setConfig_(ss, 'last_completed_slot', slot);
  } catch (error) {
    try {
      appendPostLog_(ss, {
        mode: 'Live',
        folderId: selection && selection.folderId,
        caption: selection && selection.caption,
        fileId: selection && selection.fileId,
        fileName: selection && selection.fileName,
        mediaType: selection && selection.mediaType,
        status: 'Failed',
        details: safeErrorMessage_(error)
      });
    } catch (loggingError) {
      Logger.log('Failed to write automation error to tracker: ' + safeErrorMessage_(loggingError));
    }
    throw error;
  }
}

function createPublicDriveDraftTest_(mediaType) {
  const ss = getTracker_();
  ensureState_(ss);
  const testState = getRotationState_(ss);
  const selection = selectNextEligibleMedia_(
    testState,
    getUsedFileIds_(ss),
    getLastPostedFileIdsByFolder_(ss),
    mediaType
  );
  if (!selection) {
    throw new Error('No uploadable supported ' + mediaType + ' was found in the eligible city folders.');
  }

  try {
    // Buffer also requires drafts to have a due time in the future, even though
    // saveToDraft prevents this post from being scheduled or published.
    const result = createBufferPost_(selection, true, new Date(Date.now() + 5 * 60 * 1000).toISOString());
    appendPostLog_(ss, {
      mode: 'Draft test',
      folderId: selection.folderId,
      caption: selection.caption,
      fileId: selection.fileId,
      fileName: selection.fileName,
      mediaType: selection.mediaType,
      bufferPostId: result.id,
      status: 'Draft created',
      details: 'This draft was not scheduled and will not post to Instagram.'
    });
    Logger.log('Draft created. Check Buffer > Drafts. Tracker: ' + ss.getUrl());
  } catch (error) {
    appendPostLog_(ss, {
      mode: 'Draft test',
      folderId: selection.folderId,
      caption: selection.caption,
      fileId: selection.fileId,
      fileName: selection.fileName,
      mediaType: selection.mediaType,
      status: 'Draft failed',
      details: safeErrorMessage_(error)
    });
    throw error;
  }
}

/**
 * Walks the shuffled city rotation. A city that does not have the currently
 * required media type is consumed for this round, then the next city is tried.
 */
function selectNextEligibleMedia_(state, usedFileIds, lastFileIdsByFolder, requestedMediaType) {
  const working = normalizeRotationState_(state);

  while (working.index < working.queue.length) {
    const folderId = working.queue[working.index];
    working.index += 1;
    const folder = DriveApp.getFolderById(folderId);
    let candidates = getSupportedMediaInFolder_(folder);
    if (requestedMediaType) {
      candidates = candidates.filter(function(file) {
        return mediaTypeForFile_(file) === requestedMediaType;
      });
    }
    if (candidates.length === 0) continue;

    const unused = candidates.filter(function(file) {
      return !usedFileIds.has(file.getId());
    });
    const pool = unused.length > 0 ? unused : candidates;
    const lastFileId = String(lastFileIdsByFolder[folderId] || '');
    const withoutImmediateRepeat = pool.filter(function(file) {
      return file.getId() !== lastFileId;
    });
    const choices = withoutImmediateRepeat.length > 0 ? withoutImmediateRepeat : pool;
    const selected = choices[Math.floor(Math.random() * choices.length)];

    return {
      folderId: folder.getId(),
      caption: folder.getName(),
      fileId: selected.getId(),
      fileName: selected.getName(),
      mediaType: mediaTypeForFile_(selected),
      reused: unused.length === 0,
      stateAfter: working,
    };
  }
  return null;
}

function getEligibleFolders_() {
  const root = DriveApp.getFolderById(WTM.ROOT_FOLDER_ID);
  const folders = [];
  const iterator = root.getFolders();
  while (iterator.hasNext()) {
    const folder = iterator.next();
    if (WTM.EXCLUDED_FOLDER_IDS.has(folder.getId())) continue;
    if (getSupportedMediaInFolder_(folder).length > 0) folders.push(folder);
  }
  if (folders.length === 0) throw new Error('No eligible city folders with uploadable supported media were found.');
  return folders;
}

function getSupportedMediaInFolder_(folder) {
  const files = [];
  const iterator = folder.getFiles();
  while (iterator.hasNext()) {
    const file = iterator.next();
    if (isUploadableMediaFile_(file)) files.push(file);
  }
  return files;
}

function normalizeRotationState_(state) {
  const eligibleIds = getEligibleFolders_().map(function(folder) { return folder.getId(); });
  const eligibleSet = new Set(eligibleIds);
  const queue = Array.isArray(state && state.queue) ? state.queue.map(String) : [];
  const rawIndex = Math.max(0, Math.min(Number(state && state.index || 0), queue.length));
  const processed = [];
  const remaining = [];
  const seen = new Set();

  queue.slice(0, rawIndex).forEach(function(folderId) {
    if (eligibleSet.has(folderId) && !seen.has(folderId)) {
      processed.push(folderId);
      seen.add(folderId);
    }
  });
  queue.slice(rawIndex).forEach(function(folderId) {
    if (eligibleSet.has(folderId) && !seen.has(folderId)) {
      remaining.push(folderId);
      seen.add(folderId);
    }
  });

  const missing = eligibleIds.filter(function(folderId) { return !seen.has(folderId); });
  shuffle_(missing);
  if (remaining.length === 0 && missing.length === 0) {
    const nextQueue = eligibleIds.slice();
    shuffle_(nextQueue);
    return {
      queue: nextQueue,
      index: 0,
      round: Number(state && state.round || 0) + 1,
    };
  }

  return {
    queue: processed.concat(remaining, missing),
    index: processed.length,
    round: Math.max(1, Number(state && state.round || 0)),
  };
}

function isUploadableMediaFile_(file) {
  return Boolean(mediaTypeForFile_(file)) && Number(file.getSize() || 0) <= WTM.MAX_UPLOAD_BYTES;
}

function getLastPostedFileIdsByFolder_(ss) {
  const sheet = ss.getSheetByName('Posts');
  const lastRow = sheet.getLastRow();
  const latestByFolder = {};
  if (lastRow < 2) return latestByFolder;
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.POSTS.length).getValues();
  values.forEach(function(row) {
    const folderId = row[2];
    const fileId = row[4];
    const status = row[8];
    if (folderId && fileId && (status === 'Scheduled' || status === 'Published')) {
      latestByFolder[String(folderId)] = String(fileId);
    }
  });
  return latestByFolder;
}

function safeErrorMessage_(error) {
  const message = String(error && error.message || error || 'Unknown error');
  return message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 1000);
}

function mediaTypeForFile_(file) {
  const mimeType = String(file.getMimeType() || '').toLowerCase();
  if (WTM.PHOTO_MIME_TYPES.has(mimeType)) return 'photo';
  if (WTM.VIDEO_MIME_TYPES.has(mimeType)) return 'video';
  return null;
}

function createBufferPost_(selection, saveToDraft, dueAt) {
  const channelId = getBufferChannelId_();
  const mediaUrl = uploadToCloudinary_(selection);
  const asset = selection.mediaType === 'photo'
    ? { image: { url: mediaUrl } }
    : { video: { url: mediaUrl } };

  const query = [
    'mutation CreateWorldTravelPost($input: CreatePostInput!) {',
    '  createPost(input: $input) {',
    '    ... on PostActionSuccess { post { id text dueAt } }',
    '    ... on MutationError { message }',
    '  }',
    '}'
  ].join('\n');

  const payload = bufferRequest_(query, {
    input: {
      text: selection.caption,
      channelId: channelId,
      schedulingType: 'automatic',
      mode: 'customScheduled',
      dueAt: dueAt,
      assets: [asset],
      metadata: {
        instagram: {
          type: selection.mediaType === 'photo' ? 'post' : 'reel',
          shouldShareToFeed: true,
        }
      },
      saveToDraft: saveToDraft,
    }
  });

  const result = payload && payload.data && payload.data.createPost;
  if (!result) throw new Error('Buffer returned no post result: ' + JSON.stringify(payload));
  if (result.message) throw new Error('Buffer rejected the media: ' + result.message);
  if (!result.post || !result.post.id) throw new Error('Buffer did not return a post ID: ' + JSON.stringify(result));
  return result.post;
}

/**
 * Copies exactly one selected Drive file to Cloudinary. Reusing the Drive file
 * ID as the public ID prevents duplicate Cloudinary assets on a retry or test.
 */
function uploadToCloudinary_(selection) {
  const credentials = requireCloudinaryCredentials_();
  const resourceType = selection.mediaType === 'photo' ? 'image' : 'video';
  const driveFile = DriveApp.getFileById(selection.fileId);
  const fileSize = Number(driveFile.getSize() || 0);
  if (fileSize > WTM.MAX_UPLOAD_BYTES) {
    throw new Error(
      'Unsupported media: ' + driveFile.getName() + ' is ' + fileSize +
      ' bytes, which exceeds the Apps Script upload limit of ' + WTM.MAX_UPLOAD_BYTES + ' bytes.'
    );
  }
  const blob = driveFile.getBlob().setName(driveFile.getName());
  const uploadUrl = 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(credentials.cloudName) + '/' + resourceType + '/upload';
  const authorization = 'Basic ' + Utilities.base64Encode(credentials.apiKey + ':' + credentials.apiSecret);

  const response = UrlFetchApp.fetch(uploadUrl, {
    method: 'post',
    headers: { Authorization: authorization },
    payload: {
      file: blob,
      public_id: 'world-travel-memories/drive-' + selection.fileId,
      overwrite: 'true',
      tags: 'world-travel-memories',
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('Cloudinary returned non JSON response (' + status + '): ' + body);
  }
  if (status < 200 || status >= 300 || !payload.secure_url) {
    const message = payload && payload.error && payload.error.message || JSON.stringify(payload);
    throw new Error('Cloudinary upload failed (' + status + '): ' + message);
  }
  return payload.secure_url;
}

function discoverInstagramChannel_() {
  const organizationQuery = [
    'query GetOrganizations {',
    '  account { organizations { id name } }',
    '}'
  ].join('\n');
  const organizationData = bufferRequest_(organizationQuery, {});
  const organizations = organizationData && organizationData.data && organizationData.data.account && organizationData.data.account.organizations;
  if (!organizations || organizations.length === 0) throw new Error('Buffer returned no organizations for this API key.');

  for (let i = 0; i < organizations.length; i += 1) {
    const channelQuery = [
      'query GetChannels($organizationId: OrganizationId!) {',
      '  channels(input: { organizationId: $organizationId }) {',
      '    id name displayName service isDisconnected isLocked',
      '  }',
      '}'
    ].join('\n');
    const channelData = bufferRequest_(channelQuery, { organizationId: organizations[i].id });
    const channels = channelData && channelData.data && channelData.data.channels || [];
    const instagram = channels.find(function(channel) {
      return String(channel.service).toLowerCase() === 'instagram' && !channel.isDisconnected && !channel.isLocked;
    });
    if (instagram) return instagram;
  }
  throw new Error('No connected, unlocked Instagram channel was found in Buffer.');
}

function getBufferChannelId_() {
  const ss = getTracker_();
  const existing = getConfig_(ss, 'buffer_channel_id');
  if (existing) return existing;
  const channel = discoverInstagramChannel_();
  setConfig_(ss, 'buffer_channel_id', channel.id);
  return channel.id;
}

function bufferRequest_(query, variables) {
  const apiKey = requireBufferApiKey_();
  const response = UrlFetchApp.fetch(WTM.BUFFER_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({ query: query, variables: variables }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error('Buffer returned non JSON response (' + status + '): ' + body);
  }
  if (status < 200 || status >= 300 || payload.errors) {
    throw new Error('Buffer API error (' + status + '): ' + JSON.stringify(payload));
  }
  return payload;
}

function requireBufferApiKey_() {
  const value = PropertiesService.getScriptProperties().getProperty('BUFFER_API_KEY');
  if (!value) throw new Error('Add BUFFER_API_KEY in Project Settings > Script properties before running this function.');
  return value;
}

function requireCloudinaryCredentials_() {
  const properties = PropertiesService.getScriptProperties();
  const cloudName = properties.getProperty('CLOUDINARY_CLOUD_NAME');
  const apiKey = properties.getProperty('CLOUDINARY_API_KEY');
  const apiSecret = properties.getProperty('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Project Settings > Script properties.');
  }
  return { cloudName: cloudName, apiKey: apiKey, apiSecret: apiSecret };
}

function getTracker_() {
  const properties = PropertiesService.getScriptProperties();
  const existingId = properties.getProperty('WTM_TRACKER_SPREADSHEET_ID');
  if (existingId) return SpreadsheetApp.openById(existingId);

  const ss = SpreadsheetApp.create(WTM.TRACKER_NAME);
  const config = ss.getSheets()[0];
  config.setName('Config');
  config.getRange(1, 1, 1, HEADERS.CONFIG.length).setValues([HEADERS.CONFIG]);
  const posts = ss.insertSheet('Posts');
  posts.getRange(1, 1, 1, HEADERS.POSTS.length).setValues([HEADERS.POSTS]);
  config.setFrozenRows(1);
  posts.setFrozenRows(1);
  properties.setProperty('WTM_TRACKER_SPREADSHEET_ID', ss.getId());
  return ss;
}

function ensureState_(ss) {
  if (!getConfig_(ss, 'rotation_state')) {
    saveRotationState_(ss, { queue: [], index: 0, round: 0 });
  }
  if (!getConfig_(ss, 'automation_enabled')) setConfig_(ss, 'automation_enabled', 'false');
}

function getRotationState_(ss) {
  const raw = getConfig_(ss, 'rotation_state');
  return raw ? JSON.parse(raw) : { queue: [], index: 0, round: 0 };
}

function saveRotationState_(ss, state) {
  setConfig_(ss, 'rotation_state', JSON.stringify(state));
}

function getUsedFileIds_(ss) {
  const sheet = ss.getSheetByName('Posts');
  const lastRow = sheet.getLastRow();
  const used = new Set();
  if (lastRow < 2) return used;
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.POSTS.length).getValues();
  values.forEach(function(row) {
    const fileId = row[4];
    const status = row[8];
    if (fileId && (status === 'Scheduled' || status === 'Published')) used.add(String(fileId));
  });
  return used;
}

function appendPostLog_(ss, record) {
  ss.getSheetByName('Posts').appendRow([
    new Date(),
    record.mode || '',
    record.folderId || '',
    record.caption || '',
    record.fileId || '',
    record.fileName || '',
    record.mediaType || '',
    record.bufferPostId || '',
    record.status || '',
    record.details || '',
  ]);
}

function getConfig_(ss, key) {
  const sheet = ss.getSheetByName('Config');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const match = values.find(function(row) { return row[0] === key; });
  return match ? String(match[1]) : '';
}

function setConfig_(ss, key, value) {
  const sheet = ss.getSheetByName('Config');
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(row) { return row[0]; });
    const index = keys.indexOf(key);
    if (index !== -1) {
      sheet.getRange(index + 2, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function otherMediaType_(mediaType) {
  return mediaType === 'photo' ? 'video' : 'photo';
}

function shuffle_(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = items[i];
    items[i] = items[j];
    items[j] = temp;
  }
}

