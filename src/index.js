const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB({ region: process.env.AWS_REGION });
const chime = new AWS.Chime({ region: 'us-east-1', endpoint: 'service.chime.aws.amazon.com' });

exports.handler = async(event, context, callback) => {
    console.log("Lambda is invoked with calldetails:" + JSON.stringify(event));
    let actions;

    switch (event.InvocationEventType) {
        case "NEW_INBOUND_CALL":
            console.log("INBOUND");
            // new inbound call
            actions = await newCall(event);
            break;

        case "DIGITS_RECEIVED":
            console.log("RECEIVED DIGITS ACTIONS");
            // new inbound call
            actions = await receivedDigits(event);
            break;

        case "ACTION_SUCCESSFUL":
            // on action successful
            console.log("SUCCESS ACTION");
            actions = await actionSuccessful(event);
            break;

        case "HANGUP":
            // on hangup
            console.log("HANGUP ACTION");
            if(event.CallDetails.Participants[0].Status === "Disconnected")
            await deleteAttendee(event);
            actions = [];
            break;

        default:
            // on error lets end the call
            console.log("FAILED ACTION");
            actions = [hangupAction];
    }

    const response = {
        "SchemaVersion": "1.0",
        "Actions": actions
    };

    console.log("Sending response:" + JSON.stringify(response));

    callback(null, response);
}

// New call handler
async function newCall(event) {
    // Play a welcome message after answering the call, play a prompt and gather DTMF tones
    playAudioAction.Parameters.AudioSource.Key = "welcome_message.wav";
    return [pauseAction, playAudioAction, playAudioAndGetDigitsAction];
}

// New call handler
async function receivedDigits(event) {
    // Last action was ReceiveDigits

    const fromNumber = event.CallDetails.Participants[0].From;
    const callId = event.CallDetails.Participants[0].CallId;

    switch (event.ActionData.ReceivedDigits) {
        case "*5":
            // Mute all
            var meeting = await getMeetingInfo(fromNumber, callId);

            var mapAttendee = meeting
                .filter(meeting => meeting.callId.S !== event.CallDetails.Participants[0].CallId)
                .map(meeting => meeting.attendeeId.S);

            if (mapAttendee.length != 0) {
                muteAttendeesAction.Parameters.MeetingId = meeting[0].meetingId.S;
                muteAttendeesAction.Parameters.AttendeeIds = mapAttendee;

                playAudioAction.Parameters.AudioSource.Key = "muted.wav";
                return [muteAttendeesAction, playAudioAction];
            }
            
            // no other attendee nothing to do
            return [];

        case "*6":
            // Unmute all
            var meeting = await getMeetingInfo(fromNumber, callId);

            var mapAttendee = meeting
                .filter(meeting => meeting.callId.S !== event.CallDetails.Participants[0].CallId)
                .map(meeting => meeting.attendeeId.S);

            if (mapAttendee.length != 0) {
                unmuteAttendeesAction.Parameters.MeetingId = meeting[0].meetingId.S;
                unmuteAttendeesAction.Parameters.AttendeeIds = mapAttendee;

                playAudioAction.Parameters.AudioSource.Key = "unmuted.wav";
                return [unmuteAttendeesAction, playAudioAction];
            }
            
            // no other attendee nothing to do
            return [];

        case "*7":
            // Mute
            var attendee = await getAttendeeInfo(fromNumber, callId);

            muteAttendeesAction.Parameters.MeetingId = attendee[0].meetingId.S;
            muteAttendeesAction.Parameters.AttendeeIds = [attendee[0].attendeeId.S];

            playAudioAction.Parameters.AudioSource.Key = "muted.wav";
            return [muteAttendeesAction, playAudioAction];

        case "*8":
            // Unmute
            var attendee = await getAttendeeInfo(fromNumber, callId);

            unmuteAttendeesAction.Parameters.MeetingId = attendee[0].meetingId.S;
            unmuteAttendeesAction.Parameters.AttendeeIds = [attendee[0].attendeeId.S];

            playAudioAction.Parameters.AudioSource.Key = "unmuted.wav";
            return [unmuteAttendeesAction, playAudioAction];

        default:
            return [];
    }
}

// Action successful handler
async function actionSuccessful(event) {
    console.log("ACTION_SUCCESSFUL");

    switch (event.ActionData.Type) {
        case "PlayAudioAndGetDigits":
            // Last action was PlayAudioAndGetDigits
            console.log("Join meeting using Meeting id");

            const from = event.CallDetails.Participants[0].From;
            const meetingId = event.ActionData.ReceivedDigits;

            // Get/create meeting
            const meeting = await chime.createMeeting({ ClientRequestToken: meetingId, MediaRegion: 'us-east-1' }).promise();
            console.log("meeting details:" + JSON.stringify(meeting, null, 2));

            // Get/create attendee
            const attendee = await chime.createAttendee({ MeetingId: meeting.Meeting.MeetingId, ExternalUserId: from }).promise();
            console.log("attendee details:" + JSON.stringify(attendee, null, 2));

            await updateAttendee(event, attendee.Attendee.AttendeeId);

            // Return join meeting action to bridge user to meeting
            joinChimeMeetingAction.Parameters.JoinToken = attendee.Attendee.JoinToken;
            return [joinChimeMeetingAction];

        case "JoinChimeMeeting":
            // Last action was JoinChimeMeeting
            console.log("Join meeting successful");

            // Play meeting joined and register for dtmf
            playAudioAction.Parameters.AudioSource.Key = "meeting_joined.wav";
            return [receiveDigitsAction, playAudioAction];

        case "ReceiveDigits":
            return [];

        default:
            return [playAudioAndGetDigitsAction];
    }
}

async function getAttendeeInfo(fromNumber, callId) {
    console.log("Querying using fromNumber");

    params = {
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'fromNumber = :fromNumber and callId = :callId',
        ExpressionAttributeValues: {
            ':fromNumber': { 'S': fromNumber },
            ':callId': { 'S': callId }
        }
    };

    console.log("Query attendee table:", JSON.stringify(params, null, 2));
    const attendee = await dynamodb.query(params).promise();

    if (!attendee.Items) {
        return null;
    }

    console.log("Query succes:", JSON.stringify(attendee, null, 2));
    return attendee.Items;
}

async function getMeetingInfo(fromNumber, callId) {
    console.log("Querying using fromNumber");

    params = {
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'fromNumber = :fromNumber and callId = :callId',
        ExpressionAttributeValues: {
            ':fromNumber': { 'S': fromNumber },
            ':callId': { 'S': callId }
        }
    };

    const attendee = await dynamodb.query(params).promise();
    console.log("Query succes:", JSON.stringify(attendee, null, 2));

    if (!attendee.Items) {
        return null;
    }

    var params = {
        TableName: process.env.TABLE_NAME,
        IndexName: 'meetingIdIndex',
        KeyConditionExpression: 'meetingId = :meetingId',
        ExpressionAttributeValues: {
            ':meetingId': { 'S': attendee.Items[0].meetingId.S }
        }
    };

    const attendees = await dynamodb.query(params).promise();
    console.log("Query succes:", JSON.stringify(attendees, null, 2));

    if (!attendees.Items) {
        return null;
    }

    return attendees.Items;
}

async function updateAttendee(event, attendeeId) {
    // update attendee in Dynamo DB
    var params = {
        TableName: process.env.TABLE_NAME,
        Key: {
            'fromNumber': { 'S': event.CallDetails.Participants[0].From },
            'callId': { 'S': event.CallDetails.Participants[0].CallId }
        },
        UpdateExpression: 'set meetingId = :meetingId, attendeeId = :attendeeId',
        ExpressionAttributeValues: {
            ':meetingId': { 'S': event.ActionData.ReceivedDigits },
            ':attendeeId': { 'S': attendeeId }
        },
        ReturnValues: "ALL_NEW"
    };

    console.log("Updating attendee:", JSON.stringify(params, null, 2));
    const result = await dynamodb.updateItem(params).promise();

    if (!result) {
        console.error("Unable to update attendee. Error:", JSON.stringify(result, null, 2));
    }

    console.log("Updated attendee. Result:", JSON.stringify(result, null, 2));
}

async function deleteAttendee(event) {
    // delete attendee from Dynamo DB
    var params = {
        TableName: process.env.TABLE_NAME,
        Key: {
            'fromNumber': { 'S': event.CallDetails.Participants[0].From },
            'callId': { 'S': event.CallDetails.Participants[0].CallId }
        }
    };

    console.log("Deleting attendee:", JSON.stringify(params, null, 2));
    const result = await dynamodb.deleteItem(params).promise();

    if (!result) {
        console.error("Unable to delete attendee. Error:", JSON.stringify(result, null, 2));
    }

    console.log("Deleted attendee");
}

const pauseAction = {
    "Type": "Pause",
    "Parameters": {
        "DurationInMilliseconds": "1000"
    }
};

const hangupAction = {
    "Type": "Hangup",
    "Parameters": {
        "SipResponseCode": "0"
    }
};

const playAudioAction = {
    "Type": "PlayAudio",
    "Parameters": {
        "ParticipantTag": "LEG-A",
        "AudioSource": {
            "Type": "S3",
            "BucketName": process.env.BUCKET_NAME,
            "Key": ""
        }
    }
};

const playAudioAndGetDigitsAction = {
    "Type": "PlayAudioAndGetDigits",
    "Parameters": {
        "MinNumberOfDigits": 5,
        "MaxNumberOfDigits": 5,
        "Repeat": 3,
        "InBetweenDigitsDurationInMilliseconds": 1000,
        "RepeatDurationInMilliseconds": 5000,
        "TerminatorDigits": ["#"],
        "AudioSource": {
            "Type": "S3",
            "BucketName": process.env.BUCKET_NAME,
            "Key": "meeting_pin.wav"
        },
        "FailureAudioSource": {
            "Type": "S3",
            "BucketName": process.env.BUCKET_NAME,
            "Key": "meeting_pin.wav"
        }
    }
};

const joinChimeMeetingAction = {
    "Type": "JoinChimeMeeting",
    "Parameters": {
        "AttendeeJoinToken": ""
    }
};

const receiveDigitsAction = {
    "Type": "ReceiveDigits",
    "Parameters": {
        "InputDigitsRegex": "^\\*\\d{1}$",
        "InBetweenDigitsDurationInMilliseconds": 1000,
        "FlushDigitsDurationInMilliseconds": 10000
    }
};

const muteAttendeesAction = {
    "Type": "ModifyChimeMeetingAttendees",
    "Parameters": {
        "Operation": "Mute",
        "MeetingId": "meeting-id",
        "AttendeeIds": ""
    }
};

const unmuteAttendeesAction = {
    "Type": "ModifyChimeMeetingAttendees",
    "Parameters": {
        "Operation": "Unmute",
        "MeetingId": "meeting-id",
        "AttendeeIds": ""
    }
};
