import {notificationsApi, jobsApi} from './config/api-config';

const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./config/db-config');
type JobSearch = {
  user_id: string;
  keyword: string;
  location: string;
  language: string;
  token: string;
  platform: string;
};

type JobSearchesResponse = {
  rows: JobSearch[];
};
const corsOptions = {
  origin:
    process.env.ORIGIN_URL ||
    process.env.OPENSHIFT_NODEJS_ORIGIN_URL ||
    'https://localhost:8000',
  credentials: true,
  optionsSuccessStatus: 200,
};

const searchNavigation = {
  baseScreen: 'Job',
  props: {
    screen: 'Search',
  },
} as const;

const constructJobNavigation = (jobId: string) => ({
  baseScreen: 'Job',
  props: {
    screen: 'JobDetails',
    params: {
      itemId: jobId,
    },
  },
});

const app = express();

app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(helmet());

const port = process.env.PORT || '8000';

app.listen(port, () => {
  console.log('===== STARTING SERVER =====', new Date());
  console.log(`server started at http://localhost:${port}`);
  console.log('Notifications API URL: ', process.env.NOTIFICATIONS_API_URL);
  console.log('Jobs API URL: ', process.env.JOBS_API_URL);
  console.log('PG HOST: ', process.env.PGHOST);
  console.log('PG PORT: ', process.env.PGPORT);
});

// NOTE for daily at 8 use '0 8 * * *'

const dailyJobPushNotification = async () => {
  console.log('===== START CRON JOB =====');
  const minimumPostedDate = new Date();
  minimumPostedDate.setDate(minimumPostedDate.getDate() - 1);
  minimumPostedDate.setHours(8);
  minimumPostedDate.setMinutes(0);
  minimumPostedDate.setSeconds(0);
  minimumPostedDate.setMilliseconds(0);

  try {
    console.log('Getting list of all stored job searches...');
    const jobSearches: JobSearchesResponse = await db.query(
      `
          SELECT js.user_id, js.keyword, js.location, js.language, t.token, t.platform
          FROM job_searches js
          INNER JOIN tokens t ON js.user_id = t.user_id
          LEFT JOIN user_settings us ON js.user_id = us.user_id
          WHERE js.user_removed = FALSE
          AND (us.job_push_notifications_frequency = 'daily' OR us.job_push_notifications_frequency IS NULL)
          `,
      [],
    );

    const uniqueSearchesToUserIDs = new Map<string, JobSearch[]>();
    const keywordLocationLangToUserIDs = new Map<string, string[]>();

    for (const row of jobSearches.rows) {
      const keyObject = {
        keyword: row.keyword,
        location: row.location,
        language: row.language,
      };
      const key = JSON.stringify(keyObject);
      if (keywordLocationLangToUserIDs.has(key)) {
        keywordLocationLangToUserIDs.get(key)?.push(row.user_id);
      } else {
        keywordLocationLangToUserIDs.set(key, [row.user_id]);
      }
      if (uniqueSearchesToUserIDs.has(row.user_id)) {
        uniqueSearchesToUserIDs.get(row.user_id)?.push(row);
      } else {
        uniqueSearchesToUserIDs.set(row.user_id, [row]);
      }
    }
    console.log('UserID to Searches map size:: ', uniqueSearchesToUserIDs.size);
    console.log(
      'Keyword-Location to UserID map size: ',
      keywordLocationLangToUserIDs.size,
    );
    const sortedKeywordLocationMap = new Map(
      [...keywordLocationLangToUserIDs.entries()].sort(
        (a, b) => b[1].length - a[1].length,
      ),
    );

    for await (const [key, value] of sortedKeywordLocationMap) {
      const {keyword, location, language} = JSON.parse(key);
      console.log(
        `keyword: ${keyword}, location: ${location}, language: ${language}`,
      );
      const hasUserThatNeedsNotification = value.some(userId =>
        uniqueSearchesToUserIDs.has(userId),
      );

      if (!hasUserThatNeedsNotification) {
        continue;
      }

      try {
        const response = await jobsApi.get('Jobs/SearchJobs', {
          data: {
            jobTitle: keyword,
            location: location,
            language: language,
            minimumPostedDate: minimumPostedDate,
          },
        });
        const responseData = response.data;
        const isNewJobs = responseData.new > 0 && responseData.jobs.length > 0;
        if (isNewJobs) {
          for await (const userId of value) {
            if (uniqueSearchesToUserIDs.has(userId)) {
              const userJobSearches = uniqueSearchesToUserIDs.get(userId);
              const currentSearch = userJobSearches?.find(
                search =>
                  search.keyword === keyword && search.location === location,
              );
              if (currentSearch) {
                const firstJobId = responseData.jobs[0].JobId;

                const data =
                  (responseData.new > 1 && responseData.jobs.length > 0) ||
                  !firstJobId
                    ? searchNavigation
                    : constructJobNavigation(firstJobId);
                try {
                  await notificationsApi.post(
                    'messaging/send',
                    {
                      title:
                        currentSearch.language.toUpperCase() === 'EN'
                          ? 'New Jobs Posted'
                          : "Nouvelles offres d'emploi",
                      content:
                        currentSearch.language.toUpperCase() === 'EN'
                          ? 'There are new job postings for one or more of your saved job searches!'
                          : 'Il y a de nouvelles offres d’emploi pour une ou plusieurs de vos recherches d’emploi sauvegardées!',
                      token: currentSearch.token,
                      platform: currentSearch.platform,
                      dryRun: false,
                      data,
                    },
                    {
                      auth: {
                        username: process.env.NOTIFICATIONS_API_USER || '',
                        password: process.env.NOTIFICATIONS_API_PASS || '',
                      },
                    },
                  );
                  uniqueSearchesToUserIDs.delete(userId);
                  console.log(
                    'UserID to Searches map size: ',
                    uniqueSearchesToUserIDs.size,
                  );
                } catch (e: any) {
                  console.log(
                    'Error sending notification. Message: ',
                    e.message,
                  );
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.log('Error searching jobs. Message: ', e.message);
      }
    }
    console.log('===== END CRON JOB =====');
  } catch (e: any) {
    console.log(e.message);
  }
};

cron.schedule(
  '0 8 * * *',
  async () => {
    await dailyJobPushNotification();
  },
  {
    scheduled: true,
    timezone: 'America/Los_Angeles',
  },
);

// NOTE for weekly at 8 use '0 8 * * 1'

type SearchObject = {
  keyword: string;
  location: string;
  language: string;
  token: string;
  platform: string;
};

const setUniqueSearchesToUserIDs = (
  rows: JobSearch[],
): Map<string, SearchObject[]> => {
  const uniqueSearchesToUserIDs = new Map<string, SearchObject[]>();

  for (const row of rows) {
    const searchObject: SearchObject = {
      keyword: row.keyword,
      location: row.location,
      language: row.language,
      token: row.token,
      platform: row.platform,
    };

    const key = `${row.user_id}-${row.token}`;

    if (uniqueSearchesToUserIDs.has(key)) {
      uniqueSearchesToUserIDs.get(key)?.push(searchObject);
    } else {
      uniqueSearchesToUserIDs.set(key, [searchObject]);
    }
  }
  return uniqueSearchesToUserIDs;
};

const weeklyJobPushNotification = async () => {
  console.log('===== START WEEKLY NOTIFICATION CRON JOB =====');

  try {
    console.log('Getting list of users with weekly digest preference...');
    const weeklyUsers = await db.query(
      `
        SELECT t.user_id, t.token, t.platform, js.language, js.keyword, js.location
        FROM tokens t
        INNER JOIN user_settings us ON t.user_id = us.user_id
        INNER JOIN job_searches js ON t.user_id = js.user_id
        WHERE us.job_push_notifications_frequency = 'weekly'
        AND js.user_removed = FALSE
        `,
      [],
    );

    const uniqueSearchesToUserIDs = setUniqueSearchesToUserIDs(
      weeklyUsers.rows,
    );

    for (const [key, value] of uniqueSearchesToUserIDs.entries()) {
      const userId = key.split('-')[0];
      try {
        await notificationsApi.post(
          'messaging/send',
          {
            title:
              value[0].language?.toUpperCase() === 'FR'
                ? 'Votre résumé hebdomadaire'
                : 'Your Weekly Job Digest',
            content:
              value[0].language?.toUpperCase() === 'FR'
                ? "Votre résumé hebdomadaire des offres d'emploi est prêt. Consultez votre application pour voir les nouveaux emplois!"
                : 'Your weekly job digest is ready. Check your app to see the new jobs!',
            token: value[0].token,
            platform: value[0].platform,
            dryRun: false,
            data: {
              baseScreen: 'Job',
              props: {
                screen: 'Results',
                params: {
                  isPushNotification: true,
                  pushNotificationsPayload: value?.map(search => ({
                    keyword: search.keyword,
                    city: search.location,
                    language: search.language,
                    digest: 'weekly',
                  })),
                },
              },
            },
          },
          {
            auth: {
              username: process.env.NOTIFICATIONS_API_USER || '',
              password: process.env.NOTIFICATIONS_API_PASS || '',
            },
          },
        );

        console.log(`Successfully sent notification to user: ${userId}`);
      } catch (e: any) {
        console.log(
          `Error sending weekly digest notification to user ${userId}. Message:`,
          e.message,
        );
      }
    }

    console.log('===== END WEEKLY NOTIFICATION CRON JOB =====');
  } catch (e: any) {
    console.log('Weekly notification error:', e.message);
  }
};

cron.schedule(
  '0 8 * * 1', // Every Monday at 8 AM
  async () => {
    await weeklyJobPushNotification();
  },
  {
    scheduled: true,
    timezone: 'America/Los_Angeles',
  },
);

const monthlyJobPushNotification = async () => {
  console.log('===== START MONTHLY NOTIFICATION CRON JOB =====');

  try {
    console.log('Getting list of users with monthly digest preference...');
    const monthlyUsers = await db.query(
      `
        SELECT t.user_id, t.token, t.platform, js.language, js.keyword, js.location
        FROM tokens t
        INNER JOIN user_settings us ON t.user_id = us.user_id
        INNER JOIN job_searches js ON t.user_id = js.user_id
        WHERE us.job_push_notifications_frequency = 'monthly'
        AND js.user_removed = FALSE
        `,
      [],
    );

    const uniqueSearchesToUserIDs = setUniqueSearchesToUserIDs(
      monthlyUsers.rows,
    );

    for (const [key, value] of uniqueSearchesToUserIDs.entries()) {
      const userId = key.split('-')[0];
      try {
        await notificationsApi.post(
          'messaging/send',
          {
            title:
              value[0].language?.toUpperCase() === 'FR'
                ? 'Votre résumé mensuel'
                : 'Your Monthly Job Digest',
            content:
              value[0].language?.toUpperCase() === 'FR'
                ? "Votre résumé mensuel des offres d'emploi est prêt. Consultez votre application pour voir les nouveaux emplois!"
                : 'Your monthly job digest is ready. Check your app to see the new jobs!',
            token: value[0].token,
            platform: value[0].platform,
            dryRun: false,
            data: {
              baseScreen: 'Job',
              props: {
                screen: 'Results',
                params: {
                  isPushNotification: true,
                  pushNotificationsPayload: value?.map(search => ({
                    keyword: search.keyword,
                    city: search.location,
                    language: search.language,
                    digest: 'monthly',
                  })),
                },
              },
            },
          },
          {
            auth: {
              username: process.env.NOTIFICATIONS_API_USER || '',
              password: process.env.NOTIFICATIONS_API_PASS || '',
            },
          },
        );

        console.log(
          `Successfully sent monthly notification to user: ${userId}`,
        );
      } catch (e: any) {
        console.log(
          `Error sending monthly digest notification to user ${userId}. Message:`,
          e.message,
        );
      }
    }

    console.log('===== END MONTHLY NOTIFICATION CRON JOB =====');
  } catch (e: any) {
    console.log('Monthly notification error:', e.message);
  }
};

cron.schedule(
  '0 8 1 * *', // Every 1st day of the month at 8 AM
  async () => {
    await monthlyJobPushNotification();
  },
  {
    scheduled: true,
    timezone: 'America/Los_Angeles',
  },
);

app.get('/api/trigger/daily', async (req: any, res: any) => {
  try {
    await dailyJobPushNotification();
    res.json({message: 'Daily notifications triggered.'});
  } catch (e: any) {
    res.status(500).json({error: e.message});
  }
});

app.get('/api/trigger/weekly', async (req: any, res: any) => {
  try {
    await weeklyJobPushNotification();
    res.json({message: 'Weekly notifications triggered.'});
  } catch (e: any) {
    res.status(500).json({error: e.message});
  }
});

app.get('/api/trigger/monthly', async (req: any, res: any) => {
  try {
    await monthlyJobPushNotification();
    res.json({message: 'Monthly notifications triggered.'});
  } catch (e: any) {
    res.status(500).json({error: e.message});
  }
});
