'use strict';
import express from 'express';
import { smarthome } from 'actions-on-google';
import { google } from 'googleapis';
import util from 'util';
import morgan from 'morgan';
import bodyParser from 'body-parser'


const server = express()
const port = process.env.PORT || 5001;

server.use(express.json());
server.use(bodyParser.urlencoded());// to parse form-data body
server.use(morgan('dev'));


server.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})





// Initialize Homegraph
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/homegraph'],
});


const homegraph = google.homegraph({
  version: 'v1',
  auth: auth,
});


// Hardcoded user ID
const USER_ID = '123';

server.get('/login', (request, response) => {
  console.log('Requesting login page');
  response.send(`
    <html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <body>
        <form action="/login" method="post">
          <input type="hidden"
            name="responseurl" value="${request.query.responseurl}" />
          <button type="submit" style="font-size:14pt">
            Link this service to Google
          </button>
        </form>
      </body>
    </html>
  `)
})

server.post('/login', (request, response) => {

  // Here, you should validate the user account.
  // In this sample, we do not do that.
  const responseurl = decodeURIComponent(request.body.responseurl);
  console.log(`Redirect to ${responseurl}`);
  return response.redirect(responseurl);

});

server.use('/fakeauth', (request, response) => {
  const responseurl = util.format('%s?code=%s&state=%s',
    decodeURIComponent(request.query.redirect_uri), 'xxxxxx',
    request.query.state);
  console.log(`Set redirect as ${responseurl}`);
  return response.redirect(
    `/login?responseurl=${encodeURIComponent(responseurl)}`);
});

server.use('/faketoken', (request, response) => {
  const grantType = request.query.grant_type ?
    request.query.grant_type : request.body.grant_type;
  const secondsInDay = 86400; // 60 * 60 * 24
  const HTTP_STATUS_OK = 200;
  console.log(`Grant type ${grantType}`);

  let obj;
  if (grantType === 'authorization_code') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      refresh_token: '123refresh',
      expires_in: secondsInDay,
    };
  } else if (grantType === 'refresh_token') {
    obj = {
      token_type: 'bearer',
      access_token: '123accessnew',
      expires_in: secondsInDay,
    };
  }
  response.status(HTTP_STATUS_OK)
    .json(obj);
});

const app = smarthome();

app.onSync((body) => {
  return {
    requestId: body.requestId,
    payload: {
      agentUserId: USER_ID,
      devices: [{
        id: 'washer',
        type: 'action.devices.types.WASHER',
        traits: [
          'action.devices.traits.OnOff',
          'action.devices.traits.StartStop',
          'action.devices.traits.RunCycle',
        ],
        name: {
          defaultNames: ['My Washer'],
          name: 'Washer',
          nicknames: ['Washer'],
        },
        deviceInfo: {
          manufacturer: 'Acme Co',
          model: 'acme-washer',
          hwVersion: '1.0',
          swVersion: '1.0.1',
        },
        willReportState: true,
        attributes: {
          pausable: true,
        },
      }],
    },
  };
});

const queryFirebase = async (deviceId) => {
  const snapshot = await firebaseRef.child(deviceId).once('value');
  const snapshotVal = snapshot.val();
  return {
    on: snapshotVal.OnOff.on,
    isPaused: snapshotVal.StartStop.isPaused,
    isRunning: snapshotVal.StartStop.isRunning,
  };
};
const queryDevice = async (deviceId) => {
  const data = await queryFirebase(deviceId);
  return {
    on: data.on,
    isPaused: data.isPaused,
    isRunning: data.isRunning,
    currentRunCycle: [{
      currentCycle: 'rinse',
      nextCycle: 'spin',
      lang: 'en',
    }],
    currentTotalRemainingTime: 1212,
    currentCycleRemainingTime: 301,
  };
};

app.onQuery(async (body) => {
  const { requestId } = body;
  const payload = {
    devices: {},
  };
  const queryPromises = [];
  const intent = body.inputs[0];
  for (const device of intent.payload.devices) {
    const deviceId = device.id;
    queryPromises.push(
      queryDevice(deviceId)
        .then((data) => {
          // Add response to device payload
          payload.devices[deviceId] = data;
        }));
  }
  // Wait for all promises to resolve
  await Promise.all(queryPromises);
  return {
    requestId: requestId,
    payload: payload,
  };
});

const updateDevice = async (execution, deviceId) => {
  const { params, command } = execution;
  let state; let ref;
  switch (command) {
    case 'action.devices.commands.OnOff':
      state = { on: params.on };
      ref = firebaseRef.child(deviceId).child('OnOff');
      break;
    case 'action.devices.commands.StartStop':
      state = { isRunning: params.start };
      ref = firebaseRef.child(deviceId).child('StartStop');
      break;
    case 'action.devices.commands.PauseUnpause':
      state = { isPaused: params.pause };
      ref = firebaseRef.child(deviceId).child('StartStop');
      break;
  }

  return ref.update(state)
    .then(() => state);
};

app.onExecute(async (body) => {
  const { requestId } = body;
  // Execution results are grouped by status
  const result = {
    ids: [],
    status: 'SUCCESS',
    states: {
      online: true,
    },
  };

  const executePromises = [];
  const intent = body.inputs[0];
  for (const command of intent.payload.commands) {
    for (const device of command.devices) {
      for (const execution of command.execution) {
        executePromises.push(
          updateDevice(execution, device.id)
            .then((data) => {
              result.ids.push(device.id);
              Object.assign(result.states, data);
            })
            .catch(() => console.error('EXECUTE', device.id)));
      }
    }
  }

  await Promise.all(executePromises);
  return {
    requestId: requestId,
    payload: {
      commands: [result],
    },
  };
});

app.onDisconnect((body, headers) => {
  console.log('User account unlinked from Google Assistant');
  // Return empty response
  return {};
});

server.use('/smarthome', app);

server.use('/requestsync', async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  console.log(`Request SYNC for user ${USER_ID}`);
  try {
    const res = await homegraph.devices.requestSync({
      requestBody: {
        agentUserId: USER_ID,
      },
    });
    console.log('Request sync response:', res.status, res.data);
    response.json(res.data);
  } catch (err) {
    console.error(err);
    response.status(500).send(`Error requesting sync: ${err}`);
  }
});

/**
 * Send a REPORT STATE call to the homegraph when data for any device id
 * has been changed.
 */
// TODO: convert to express thing instead of f-function database trigger

let FAKE_DEVICES_DB = {
  deviceId123: {
    OnOff: { on: true },
    StartStop: { isPaused: false, isRunning: true }
  }
}



const reportStateToGoogle = async (deviceId) => {

  console.log('Firebase write event triggered Report State');
  const currentStateOfDevice = FAKE_DEVICES_DB[deviceId];

  const requestBody = {
    requestId: 'ff36a3cc', /* Any unique ID */
    agentUserId: USER_ID,
    payload: {
      devices: {
        states: {
          /* Report the current state of our washer */
          [deviceId]: {
            on: currentStateOfDevice.OnOff.on,
            isPaused: currentStateOfDevice.StartStop.isPaused,
            isRunning: currentStateOfDevice.StartStop.isRunning,
          },
        },
      },
    },
  };
  try {
    const res = await homegraph.devices.reportStateAndNotification({
      requestBody,
    });

    console.log('Report state response:', res.status, res.data);

  } catch (error) {
    console.log("error in reporting: ", error)
  }

}
// reportStateToGoogle('deviceId123');




server.post('/onoff', (req, res) => {

  const deviceid = req.body.deviceid;
  const action = req.body.action; // 'on' or 'off'

  // TODO:  mark device as on or off

  reportStateToGoogle(deviceid)

});

